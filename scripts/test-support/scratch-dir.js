// A scratch directory that does not outlive the test process.
//
// Why it exists. Tests need somewhere to write, so they call mkdtempSync, and
// mkdtempSync is a create with no matching remove. Left alone that is a leak
// nobody sees: it costs nothing on the run that makes it, and it accumulates
// without limit, on the disk of anyone who runs this suite, until something
// unrelated to their change fails for want of space or inodes.
//
// Why removal is registered here rather than written at each call site. A test
// that throws never reaches its own cleanup line, and node:test carries on with
// the rest of the file, so exactly the runs that go wrong leak the most. An
// exit hook needs no discipline at the call site to be correct, which is the
// only kind of rule that survives a year of changes.
//
// Named for what it is rather than after os.tmpdir(), which is a different
// thing: that one names the parent every process shares, this one makes a
// directory inside it that belongs to one test file.
//
// A copy of this file lives in every unit that can be vendored on its own, so
// that a unit copied out by itself still cleans up after itself. The leak check
// that runs the suite is what stops any of it from decaying: it fails the run
// if anything is left behind.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// One listener for the whole process, not one per directory. node warns past
// ten, and a single test file makes far more than ten.
const made = new Set();

process.on('exit', () => {
  for (const dir of made) {
    // Best effort, deliberately not fatal: a directory that survives costs the
    // OS a reap, whereas a cleanup that can throw turns a green suite red,
    // which is a worse bug than the one this file fixes. maxRetries covers
    // Windows, where a directory can still be briefly busy at exit.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch { /* left for the OS to reap */ }
  }
});

function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}

module.exports = { scratchDir };
