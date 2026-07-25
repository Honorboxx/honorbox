// The suite runner that also refuses to let the suite litter.
//
// Why this exists. Every test that needs a directory calls mkdtempSync, which
// has no matching remove, so left unattended a suite quietly fills the system
// temp directory of every machine it runs on. That is invisible while it is
// happening and expensive by the time anyone looks: it costs inodes and disk,
// and it eventually fails a test for a reason unrelated to the change.
//
// Cleaning the directories up is the fix; this file is what stops the fix from
// decaying. A rule that lives in somebody's memory lasts until the next
// contributor, and the next contributor is often a stranger with a pull
// request. A rule the suite enforces lasts.
//
// How it avoids becoming the flake it is meant to prevent. The obvious design
// counts entries in the system temp directory before and after, which is wrong
// twice over: anything else on the machine writing there during the run reads
// as our leak, and two suites run at once each blame the other. So the run gets
// a temp directory of its own. TMPDIR, TMP and TEMP all point at it, which is
// every variable os.tmpdir() consults on every platform, so mkdtempSync inside
// the tests lands there and nowhere else. Afterwards that directory must be
// empty. Nothing outside this process tree can write to it, so there is no
// reading of it that depends on timing, on what else is running, or on how many
// test files node chose to run in parallel.
//
// Run: npm test [test files...]

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TESTS = path.join('scripts', 'test');

// The suite is the tracked test files, listed here rather than left to a shell
// glob: npm runs scripts through cmd.exe on Windows, which does not expand one,
// and bare `node --test` cannot be used instead because it would collect
// scripts/test/fixtures/ as test files too.
function suiteFiles() {
  return fs.readdirSync(path.join(ROOT, TESTS))
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(TESTS, f));
}

const targets = process.argv.slice(2);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'honorbox-leakcheck-'));

const run = spawnSync(process.execPath, ['--test', ...(targets.length ? targets : suiteFiles())], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
});

let left = [];
try {
  left = fs.readdirSync(scratch).sort();
} catch (e) {
  // Being unable to read it is a broken check, not a clean run, and saying so
  // beats reporting a leak of zero that was never measured.
  console.error(`leak check could not read ${scratch}: ${e.message}`);
  process.exit(1);
}

// Removed whatever the verdict is, including the leak itself: a check that
// litters while complaining about litter would be its own bug.
try {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
} catch { /* left for the OS to reap */ }

if (left.length) {
  // The prefix names the test file that made it, which is the whole diagnosis,
  // so a sample is worth more than the count on its own. Ten is enough to see
  // whether one file leaked or several.
  console.error(`\nleak: the suite left ${left.length} temporary ${left.length === 1 ? 'directory' : 'directories'} behind`);
  for (const name of left.slice(0, 10)) console.error(`  ${name}`);
  if (left.length > 10) console.error(`  ...and ${left.length - 10} more`);
  console.error('\nEvery mkdtempSync needs its directory removed. scripts/test-support/scratch-dir.js does that;');
  console.error('call scratchDir() instead of fs.mkdtempSync() and the removal is handled.');
}

// A red suite is reported as a red suite, and a leak on top of a failure is
// usually the failure's doing. A run killed by a signal has no status at all,
// which is not a pass.
if (run.error) {
  console.error(`leak check could not run the suite: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) process.exit(run.status ?? 1);
process.exit(left.length ? 1 : 0);
