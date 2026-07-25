// A copy of THIS store, built somewhere no other test can reach.
//
// Why it exists. The checks that judge built output used to spawn the builder
// with cwd set to the repository and then read the repository's own dist/.
// build.js opens by removing dist/ and repopulating it, and `node --test` runs
// test FILES in parallel, so a reader could list a file and have it deleted
// before the read landed. One CI cell failed exactly that way, with ENOENT on a
// dist page, while the other eight passed. A suite that goes red for reasons
// unrelated to the change teaches people to press re-run, and after that it
// certifies nothing.
//
// Two tests also edited a file in the working tree, built, and put it back in a
// finally. That is the same defect wearing different clothes: for a fifth of
// every run, products/honorbox-pro.md was corrupt on disk and pages/ held a
// fixture page, where any parallel test file could read them, any parallel
// build could ship them, and a crash could leave the fixture page behind to be
// deployed.
//
// The rule both halves come down to: a test that needs built output owns the
// build. Nothing reads a directory another test can empty, and nothing writes
// inside the repository.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');

// Everything build.js reads out of the repository root, copied whole. The
// fixture builds THIS store rather than a stand-in, because the checks
// downstream are worth having only if they scan what actually ships: a
// hand-written miniature store cannot drift from the real one, which sounds
// like a feature and means it can no longer catch anything.
//
// The literal list is held to build.js by a test in core.test.js. What that
// test cannot see, stated rather than implied away: build.js also resolves
// paths an author wrote (an og_image, an <img> src, the configured theme's
// preview). Those are relative references that land inside the directories
// below, and no static reading of the source can prove it.
const INPUTS = ['store.config.json', 'products', 'pages', 'docs', 'themes', 'assets', 'static', 'ledger'];

// A throwaway store, for a test that needs to change a source file and watch
// what the builder does about it. The caller owns it and calls cleanup(), which
// is the whole of the cleanup: nothing outside the temporary directory was
// touched, so there is no restore step to get wrong or to skip on a crash.
function storeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honorbox-store-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'build.js'), path.join(root, 'scripts', 'build.js'));
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(root, 'scripts', 'lib'), { recursive: true });
  for (const name of INPUTS) {
    const from = path.join(ROOT, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(root, name), { recursive: true });
  }

  return {
    at: (...p) => path.join(root, ...p),
    build() {
      const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.js')], {
        cwd: root, encoding: 'utf8',
      });
      return { code: r.status, err: String(r.stderr || '') };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// The store as it ships, built once per test process.
//
// Sharing it is safe in the one way that matters: `node --test` gives each test
// file its own process and runs the tests inside a file one after another, so
// the readers here are sequential and nothing else can see this directory. Only
// the pages come back, never the directory or the builder, so a caller has
// nothing to list, edit or delete.
//
// Each call still gets its own array, because the one in-place sort or splice
// it would take to make one test's reading depend on another's is exactly the
// mistake the rest of this file exists to stop. Freezing instead would be worse
// than useless: these callers are not in strict mode, so the mutation would be
// dropped in silence rather than refused.
let pages = null;

function builtPages() {
  if (!pages) {
    const fixture = storeFixture();
    const r = fixture.build();
    if (r.code !== 0) {
      fixture.cleanup();
      throw new Error(`the store must build before its output can be judged:\n${r.err}`);
    }
    const dist = fixture.at('dist');
    pages = fs.readdirSync(dist)
      .filter((f) => f.endsWith('.html'))
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(dist, f), 'utf8')]);
    // Best effort, and deliberately not fatal: a temporary directory that
    // outlives the run costs a forker nothing and the OS reaps it, whereas a
    // cleanup that can fail a green suite is a new flake in place of the old
    // one. Windows is the case in mind, where a directory can still be busy.
    process.on('exit', () => {
      try { fixture.cleanup(); } catch { /* left for the OS to reap */ }
    });
  }
  return pages.map(([name, body]) => [name, body]);
}

module.exports = { INPUTS, storeFixture, builtPages };
