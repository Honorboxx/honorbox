'use strict';
// Driver-level tests for scripts/fulfill.js with a stubbed fetch: no
// network, no live keys. Covers the HTTP call shapes and the state files
// the fulfillment workflows depend on.
//
// Run: node --test scripts/test/fulfill-driver.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Requiring the driver must not run main(); build.js sets the precedent
// (module.exports + require.main guard).
const driver = require('../fulfill.js');

function stubFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const r of routes) if (String(url).includes(r.match)) return r.res(String(url), init);
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const jsonRes = (obj, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

function paidSession(id, created, over = {}) {
  return {
    id,
    status: 'complete',
    payment_status: 'paid',
    payment_link: 'plink_1',
    created,
    amount_total: 2900,
    currency: 'usd',
    customer_details: { address: { country: 'DE' } },
    custom_fields: [{ key: 'github_username', text: { value: 'octocat' } }],
    ...over,
  };
}

// Run main() against a temp working set: config + state + ledger paths in
// their own directory, argv and env staged and restored around the call.
async function runMain(dir, routes) {
  const cfg = path.join(dir, 'store.config.json');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({
      fulfillment: [{ payment_link: 'plink_1', product: 'P', repo: 'o/r' }],
    }));
  }
  const savedArgv = process.argv;
  const savedEnv = { key: process.env.STRIPE_SECRET_KEY, tok: process.env.GH_FULFILL_TOKEN };
  process.argv = [savedArgv[0], 'fulfill.js',
    '--config', cfg,
    '--state', path.join(dir, 'state', 'fulfill-state.json'),
    '--ledger', path.join(dir, 'ledger', 'ledger.json')];
  process.env.STRIPE_SECRET_KEY = 'rk_test_stub';
  process.env.GH_FULFILL_TOKEN = 'ghp_test_stub';
  const { calls, restore } = stubFetch(routes);
  try {
    await driver.main();
  } finally {
    restore();
    process.argv = savedArgv;
    if (savedEnv.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedEnv.key;
    if (savedEnv.tok === undefined) delete process.env.GH_FULFILL_TOKEN;
    else process.env.GH_FULFILL_TOKEN = savedEnv.tok;
  }
  return { calls, readState: (f) => JSON.parse(fs.readFileSync(path.join(dir, 'state', f), 'utf8')) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-fulfill-'));

test('stripe requests pin Stripe-Version 2024-06-20', async () => {
  // The account default is a broken preview API version; init.js pins every
  // call and fulfill.js must hold the same line.
  const { calls, restore } = stubFetch([
    { match: 'api.stripe.com', res: () => jsonRes({ data: [], has_more: false }) },
  ]);
  try {
    await driver.listSessionsSince(0, 'rk_test_stub');
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Stripe-Version'], '2024-06-20', JSON.stringify(calls[0].init.headers));
});

test('happy path end to end: session fulfilled, ledger row, state advanced', async () => {
  const dir = tmp();
  const s = paidSession('cs_e2e_1', 1_700_000_000);
  const { calls, readState } = await runMain(dir, [
    { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) },
    { match: 'api.github.com', res: () => jsonRes({}, 201) },
  ]);
  const invite = calls.find((c) => c.url.includes('api.github.com'));
  assert.ok(invite, 'GitHub invite must be called');
  assert.equal(invite.url, 'https://api.github.com/repos/o/r/collaborators/octocat');
  assert.equal(invite.init.method, 'PUT');
  const state = readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_e2e_1']);
  assert.equal(state.failures.length, 0);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.total_sales, 1);
  assert.deepEqual(readState('new-sales.json'), ['octocat']);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'HAD_ACTIVITY')), 'activity flag set on a run with sales');
});

test('transient invite failure retries on the next poll; success then fulfills', async () => {
  // A GitHub 502 is not the buyer's fault: the session must NOT be marked
  // processed (so the next poll retries) and must NOT burn a
  // needs_attention ledger row.
  const dir = tmp();
  const s = paidSession('cs_retry_1', 1_700_000_000);
  const stripe = { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) };
  const first = await runMain(dir, [stripe, { match: 'api.github.com', res: () => jsonRes({ message: 'bad gateway' }, 502) }]);
  let state = first.readState('fulfill-state.json');
  assert.deepEqual(state.processed, [], 'transient failure must stay unprocessed');
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].transient, true);
  let ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 0, 'no ledger row for a retryable failure');
  // GitHub recovers: the next poll picks the same session up and fulfills
  const second = await runMain(dir, [stripe, { match: 'api.github.com', res: () => jsonRes({}, 201) }]);
  state = second.readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_retry_1']);
  ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 1);
  assert.ok(!ledger.rows[0].needs_attention);
});

test('permanent invite failure (404 user) goes straight to needs_attention with a hint', async () => {
  const dir = tmp();
  const s = paidSession('cs_perm_1', 1_700_000_000);
  const { readState } = await runMain(dir, [
    { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) },
    { match: 'api.github.com', res: () => jsonRes({ message: 'Not Found' }, 404) },
  ]);
  const state = readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_perm_1'], 'permanent failure is processed, humans take over');
  assert.match(state.failures[0].error, /no such GitHub user/);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows[0].needs_attention, true);
});

test('transient retries are bounded: attempt cap converts to needs_attention', async () => {
  const dir = tmp();
  const s = paidSession('cs_cap_1', 1_700_000_000);
  const stripe = { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) };
  const flaky = { match: 'api.github.com', res: () => jsonRes({ message: 'bad gateway' }, 502) };
  const { MAX_INVITE_ATTEMPTS } = require('../lib/fulfill-core.js');
  for (let i = 0; i < MAX_INVITE_ATTEMPTS; i++) await runMain(dir, [stripe, flaky]);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'fulfill-state.json'), 'utf8'));
  assert.deepEqual(state.processed, ['cs_cap_1'], 'cap reached: stop retrying, surface it');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.filter((r) => r.needs_attention).length, 1);
});

test('readJson: missing file falls back, corrupt file fails loud', () => {
  // A missing state file is a fresh install; a CORRUPT one (truncated
  // commit, bad merge) silently resetting cursor=0 and processed=[] is a
  // silent-failure hazard on money-adjacent state. Parse errors must throw
  // and name the file.
  const dir = tmp();
  const missing = path.join(dir, 'nope.json');
  assert.deepEqual(driver.readJson(missing, { cursor: 0 }), { cursor: 0 });
  const corrupt = path.join(dir, 'state.json');
  fs.writeFileSync(corrupt, '{"cursor": 12, "processed": [truncated');
  assert.throws(() => driver.readJson(corrupt, { cursor: 0 }), new RegExp('state\\.json'));
});

test('HAD_ACTIVITY is cleared again on a quiet run', async () => {
  // The workflows commit state/ wholesale and gate the ledger-publish step
  // on this file. If a run with no new sales leaves last run's flag on
  // disk, the gate is permanently open after the first sale ever.
  const dir = tmp();
  const s = paidSession('cs_flag_1', 1_700_000_000);
  const stripe = (sessions) => ({ match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) });
  const github = { match: 'api.github.com', res: () => jsonRes({}, 201) };
  await runMain(dir, [stripe([s]), github]);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'HAD_ACTIVITY')), 'flag set by the active run');
  // second run: same session comes back inside the overlap window, already processed
  await runMain(dir, [stripe([s]), github]);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'HAD_ACTIVITY')), 'quiet run must clear the flag');
});
