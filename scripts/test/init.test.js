'use strict';
// Tests for scripts/init.js argument/config validation, via spawn. Every
// case here exits before any Stripe call is attempted: no network, no keys.
//
// Run: node --test scripts/test/init.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INIT = path.join(__dirname, '..', 'init.js');

function runInit(args, env = {}) {
  return spawnSync(process.execPath, [INIT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, STRIPE_SECRET_KEY: 'rk_test_never_used', ...env },
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-init-'));

test('init: missing or corrupt config dies BEFORE anything would be created', () => {
  // The config is written AFTER the Stripe objects exist. If it cannot be
  // read, a real run would leave a live, buyer-visible payment link with no
  // fulfillment grant wired: paid orders that never deliver. So the config
  // must be validated up front, which also makes --dry-run catch it.
  const missing = runInit(['--name', 'T', '--price', '2900', '--repo', 'o/r',
    '--config', path.join(tmp(), 'nope.json'), '--dry-run']);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /nope\.json/, missing.stderr);

  const dir = tmp();
  const corrupt = path.join(dir, 'store.config.json');
  fs.writeFileSync(corrupt, '{ not json');
  const bad = runInit(['--name', 'T', '--price', '2900', '--repo', 'o/r',
    '--config', corrupt, '--dry-run']);
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /store\.config\.json/, bad.stderr);
});

test('init: --dry-run with a valid config previews and creates nothing', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  const before = JSON.stringify({ name: 'S', url: 'https://s.io', fulfillment: [] }, null, 2) + '\n';
  fs.writeFileSync(cfg, before);
  const res = runInit(['--name', 'My Tool', '--price', '2900', '--repo', 'o/r',
    '--config', cfg, '--products', path.join(dir, 'products'), '--dry-run']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /dry run/);
  assert.match(res.stdout, /\$29 one-time/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before, 'dry run must not touch the config');
  assert.ok(!fs.existsSync(path.join(dir, 'products')), 'dry run must not scaffold');
});

test('init: missing required args die with exit 2', () => {
  for (const args of [
    [], // no name
    ['--name', 'T'], // no price
    ['--name', 'T', '--price', '50'], // price below 100 cents
    ['--name', 'T', '--price', '2900'], // no repo
    ['--name', 'T', '--price', '2900', '--repo', 'not-a-repo'],
  ]) {
    const res = runInit(args);
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
  }
});
