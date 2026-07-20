'use strict';
// Driver-level tests for scripts/reconcile-subs.js with a stubbed fetch: no
// network, no live keys. These cover the properties that only show up once the
// I/O is wired: that the feature is genuinely off by default, that a tripped
// breaker performs no HTTP DELETE at all, and that reporting-only means what
// it says.
//
// Run: node --test scripts/test/subs-driver.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const driver = require('../reconcile-subs.js');

// A test must never write into the repository's own state/. The reconciler
// defaults --state and --bots-state to paths under the working directory, so a
// harness that forgets to redirect them silently commits test data, or worse,
// edits live ops state. This asserts the repo's state/ is untouched by the run.
const REPO_STATE = path.join(__dirname, '..', '..', 'state');
function repoStateFingerprint() {
  if (!fs.existsSync(REPO_STATE)) return 'absent';
  return fs.readdirSync(REPO_STATE).sort().map((f) => {
    const p = path.join(REPO_STATE, f);
    return `${f}:${fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8').length : 'dir'}`;
  }).join('|');
}
const STATE_BEFORE = repoStateFingerprint();

test.after(() => {
  assert.equal(repoStateFingerprint(), STATE_BEFORE, 'a test wrote into the repository state/ directory');
});

function stubFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', init });
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

function subscription(id, status, user, over = {}) {
  return { id, status, items: { data: [{ price: { id: 'price_sub' }, quantity: 1 }] }, ...over };
}

function session(id, subId, user) {
  return {
    id, created: 1_700_000_000, subscription: subId,
    custom_fields: [{ key: 'github_username', text: { value: user } }],
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hb-subs-'));
}

async function runMain(dir, routes, config, stateSeed) {
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify(config));
  const statePath = path.join(dir, 'state', 'subscriptions.json');
  if (stateSeed) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(stateSeed));
  }
  const savedArgv = process.argv;
  const savedEnv = { key: process.env.STRIPE_SECRET_KEY, tok: process.env.GH_FULFILL_TOKEN };
  const logs = [];
  const savedLog = console.log;
  const savedErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.GH_FULFILL_TOKEN = 'ghp_x';
  // --bots-state MUST be pointed into the temp dir. Without it the reconciler
  // falls back to its default, state/bots-state.json relative to the working
  // directory, and a test run writes a fake revocation into the repository's
  // real state file. That happened once: it polluted live ops state with a
  // revocation for a repo that does not exist.
  const botsStatePath = path.join(dir, 'state', 'bots-state.json');
  process.argv = ['node', 'reconcile-subs.js', '--config', cfg, '--state', statePath,
    '--bots-state', botsStatePath, '--force'];
  const f = stubFetch(routes);
  try {
    await driver.main(async () => {});
  } finally {
    f.restore();
    process.argv = savedArgv;
    process.env.STRIPE_SECRET_KEY = savedEnv.key;
    process.env.GH_FULFILL_TOKEN = savedEnv.tok;
    console.log = savedLog;
    console.error = savedErr;
  }
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  return { calls: f.calls, logs: logs.join('\n'), state, statePath };
}

const FULFILLMENT = [{ price: 'price_sub', product: 'Widget', repo: 'acme/widget' }];

// --- binding property 1: off by default -------------------------------------

test('a store with no subscriptions config makes no calls and writes no state', async () => {
  const dir = tmpdir();
  // Every route throws. If the reconciler touches the network at all, this
  // test fails loudly rather than passing on a stub that happened to answer.
  const { calls, logs, state } = await runMain(dir, [], { fulfillment: FULFILLMENT });
  assert.equal(calls.length, 0, 'no HTTP call may be made when the feature is off');
  assert.equal(state, null, 'no state file may be created when the feature is off');
  assert.match(logs, /not configured/);
});

// --- reporting only ---------------------------------------------------------

test('enforce false lists revocations and performs none', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: false, grace_days: 7 } },
    {
      version: 1, cursor: 1, last_pass: null, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  const deletes = calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 0, 'reporting only must issue no DELETE');
  assert.match(logs, /WOULD REVOKE \(reporting only, nothing was changed\)/);
  assert.match(logs, /REPORTING ONLY/);
  assert.ok(state.grants['acme/widget|alice'], 'the grant record survives a dry run');
});

// --- the breaker, at the driver level ---------------------------------------

test('a tripped breaker issues no DELETE at all and records what it held back', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // Ten subscribers on record, all cancelled at once. That is 100%, far over
  // the limit, and is what a config typo or a wrong key looks like.
  const grants = {};
  const users = {};
  const subs = [];
  for (let i = 0; i < 10; i++) {
    grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: long_ago };
    users[`sub_${i}`] = `u${i}`;
    subs.push(subscription(`sub_${i}`, 'canceled'));
  }
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    { version: 1, cursor: 1, users, grants, breaker: { tripped_at: null, would_revoke: [] } }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'a tripped breaker must remove nobody');
  assert.match(logs, /REVOCATION REFUSED, nothing was changed/);
  assert.equal(state.breaker.would_revoke.length, 10, 'and it records exactly what it wanted to do');
  assert.ok(state.breaker.tripped_at);
  assert.equal(Object.keys(state.grants).length, 10, 'every grant record survives');
});

test('an armed reconciler within the limit does revoke, loudly', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // Ten on record, one cancelled and nine still active: routine churn.
  const grants = {};
  const users = {};
  const subs = [];
  for (let i = 0; i < 10; i++) {
    grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: i === 0 ? long_ago : null };
    users[`sub_${i}`] = `u${i}`;
    subs.push(subscription(`sub_${i}`, i === 0 ? 'canceled' : 'active'));
  }
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    { version: 1, cursor: 1, users, grants, breaker: { tripped_at: null, would_revoke: [] } }
  );
  const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/collaborators/'));
  assert.equal(deletes.length, 1, 'exactly the one lapsed customer');
  assert.match(deletes[0].url, /acme\/widget\/collaborators\/u0/);
  assert.match(logs, /WARN: REVOKED u0 from acme\/widget/);
  assert.match(logs, /Undo: gh api -X PUT/);
  assert.equal(state.grants['acme/widget|u0'], undefined, 'the record is cleared');
  assert.ok(state.grants['acme/widget|u1'], 'and the active customers are untouched');
});

// --- the enumeration contract -----------------------------------------------

test('subscriptions are listed with status=all, or cancellations are invisible', async () => {
  const dir = tmpdir();
  const { calls } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
  );
  const listCall = calls.find((c) => c.url.includes('/v1/subscriptions'));
  assert.match(listCall.url, /status=all/);
  assert.match(listCall.init.headers['Stripe-Version'], /2024-06-20/);
});

test('a Stripe failure aborts the pass rather than revoking on partial data', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  await assert.rejects(
    runMain(
      dir,
      [{ match: '/v1/subscriptions', res: () => jsonRes({ error: 'boom' }, 500) }],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
      {
        version: 1, cursor: 1, users: { sub_a: 'alice' },
        grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
        breaker: {},
      }
    ),
    /Stripe \/v1\/subscriptions/
  );
});

test('an unreadable subscriptions response is refused, not read as an empty store', async () => {
  const dir = tmpdir();
  await assert.rejects(
    runMain(
      dir,
      [{ match: '/v1/subscriptions', res: () => jsonRes({ data: null }) }],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
      { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
    ),
    /refusing to reconcile on an unreadable response/
  );
});

// --- granting ---------------------------------------------------------------

test('an active subscription with a known username is invited', async () => {
  const dir = tmpdir();
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'active')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [session('cs_1', 'sub_a', 'alice')], has_more: false }) },
      { match: '/collaborators/', res: () => jsonRes({}, 201) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
  );
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.match(puts[0].url, /acme\/widget\/collaborators\/alice/);
  assert.ok(state.grants['acme/widget|alice']);
  assert.match(logs, /granted alice -> acme\/widget/);
});

// --- absence as evidence, the third instance -------------------------------
// Both bugs this code has already had came from reading "missing from a set" as
// "does not exist". These are the same shape in two new places.

test('a pending invitation past the first page is still cancelled on revocation', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // GitHub returns 30 invitations per page by default and paginates the rest.
  // A store holding more than one page of unaccepted invitations puts the
  // lapsed customer's invitation somewhere past page one, where a single-page
  // read cannot see it. Absent from page one is not absent.
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, invitee: { login: `other${i}` } }));
  const { calls, logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      {
        match: '/invitations',
        res: (url) => {
          if (url.includes('/invitations/')) return jsonRes({}, 204); // the delete
          return jsonRes(url.includes('page=2') ? [{ id: 77, invitee: { login: 'alice' } }] : filler);
        },
      },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  assert.match(logs, /REVOKED alice from acme\/widget/);
  const invDeletes = calls.filter((c) => c.method === 'DELETE' && /\/invitations\/77$/.test(c.url));
  assert.equal(invDeletes.length, 1,
    'the revoked customer keeps a live invitation they can still accept if only page one is read');
});

test('a customer whose new subscription is past_due is not revoked over their old one', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // Alice re-subscribed, so Stripe cancelled sub_old and opened sub_new. Our
  // grant record still names sub_old, because that is the subscription it was
  // written from and nothing ever refreshes it. sub_new is past_due: Stripe is
  // still retrying her card and she has not left. Protection is looked up by
  // the recorded subscription id, so the hold on sub_new never reaches her
  // grant, and the most important rule in this engine (past_due is never a
  // lapse) is defeated by a stale id.
  const { calls, logs, state } = await runMain(
    dir,
    [
      {
        match: '/v1/subscriptions',
        res: () => jsonRes({
          data: [subscription('sub_old', 'canceled'), subscription('sub_new', 'past_due')],
          has_more: false,
        }),
      },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_old: 'alice', sub_new: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_old', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0,
    'a customer with a live past_due subscription must never be revoked');
  assert.doesNotMatch(logs, /REVOKED alice/);
  assert.ok(state.grants['acme/widget|alice'], 'and her grant record survives');
});

test('a revocation GitHub could not confirm is not reported as done', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // She renamed her GitHub account, so the old login 404s. The person is still
  // a collaborator under the new name. Reporting a clean REVOKED here tells the
  // seller enforcement worked when nothing was taken away.
  const { logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({ message: 'Not Found' }, 404) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  assert.match(logs, /could not be confirmed|was not a collaborator/,
    'a 404 must be reported as unconfirmed, not as a completed revocation');
});

test('a past_due customer is neither granted nor revoked', async () => {
  const dir = tmpdir();
  const { calls, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'past_due')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: null } },
      breaker: {},
    }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(state.grants['acme/widget|alice'].lapsed_since, null, 'no grace clock may start for past_due');
});
