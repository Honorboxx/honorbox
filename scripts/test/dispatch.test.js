'use strict';
// Tests for the webhook-mode relays (webhook-mode/relay-*.mjs): Stripe
// signature verification, the repository_dispatch payload, and the full
// request handler with a stubbed fetch. No network, no live keys.
//
// Run: node --test scripts/test/dispatch.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const relayUrl = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'webhook-mode', f)).href;
const relays = (async () => ({
  cloudflare: await import(relayUrl('relay-cloudflare.mjs')),
  valtown: await import(relayUrl('relay-node.mjs')),
}))();

// Arbitrary test secret — the same string goes to the verifier and the
// in-test HMAC, exactly as Stripe uses the whsec_... value on both ends.
const SECRET = 'whsec_test_Kd83maV9pQ27xLtN51RfB4';
const NOW = 1_700_000_000;

function hmacHex(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
// Build a Stripe-Signature header the way Stripe does: HMAC over `${t}.${body}`.
function sigHeader(body, { secret = SECRET, t = NOW } = {}) {
  return `t=${t},v1=${hmacHex(`${t}.${body}`, secret)}`;
}

const EVENT = {
  id: 'evt_1',
  type: 'checkout.session.completed',
  livemode: true,
  created: NOW,
  data: { object: { id: 'cs_test_abc123', amount_total: 2900 } },
};
const BODY = JSON.stringify(EVENT);

test('known-good signature verifies (both relay variants)', async () => {
  for (const [name, mod] of Object.entries(await relays)) {
    const ok = await mod.verifyStripeSignature(BODY, sigHeader(BODY), SECRET, { now: NOW });
    assert.equal(ok, true, name);
  }
});

test('tampered payload is rejected', async () => {
  const header = sigHeader(BODY); // signed over the ORIGINAL body
  const tampered = BODY.replace('cs_test_abc123', 'cs_test_evil99');
  assert.notEqual(tampered, BODY);
  for (const [name, mod] of Object.entries(await relays)) {
    const ok = await mod.verifyStripeSignature(tampered, header, SECRET, { now: NOW });
    assert.equal(ok, false, name);
  }
});

test('signature made with the wrong secret is rejected', async () => {
  const forged = sigHeader(BODY, { secret: 'whsec_attacker_guess' });
  for (const [name, mod] of Object.entries(await relays)) {
    assert.equal(await mod.verifyStripeSignature(BODY, forged, SECRET, { now: NOW }), false, name);
  }
});

test('timestamps outside the replay window are rejected', async () => {
  for (const [name, mod] of Object.entries(await relays)) {
    const at = (t) => mod.verifyStripeSignature(BODY, sigHeader(BODY, { t }), SECRET, { now: NOW });
    assert.equal(await at(NOW - 301), false, `${name} stale`);
    assert.equal(await at(NOW + 301), false, `${name} future`);
    assert.equal(await at(NOW - 299), true, `${name} inside window`);
  }
});

test('malformed or missing headers are rejected, not crashed', async () => {
  const junk = ['', null, undefined, 'garbage', 't=abc,v1=deadbeef',
    `v1=${hmacHex(`${NOW}.${BODY}`, SECRET)}`, // no timestamp
    `t=${NOW}`, // no signature
    `t=${NOW},v1=tooshort`];
  for (const [name, mod] of Object.entries(await relays)) {
    for (const h of junk) {
      assert.equal(await mod.verifyStripeSignature(BODY, h, SECRET, { now: NOW }), false,
        `${name}: ${String(h)}`);
    }
  }
});

test('secret rolling: any one valid v1 among several passes', async () => {
  const good = hmacHex(`${NOW}.${BODY}`, SECRET);
  const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${good}`;
  for (const [name, mod] of Object.entries(await relays)) {
    assert.equal(await mod.verifyStripeSignature(BODY, header, SECRET, { now: NOW }), true, name);
  }
});

test('dispatch payload shape — and no raw session id leaks', async () => {
  const wantRef = crypto.createHash('sha256').update('cs_test_abc123').digest('hex').slice(0, 10);
  for (const [name, mod] of Object.entries(await relays)) {
    const d = await mod.buildDispatch(EVENT);
    assert.deepEqual(d, {
      event_type: 'honorbox_sale',
      client_payload: {
        event: 'checkout.session.completed',
        livemode: true,
        created: NOW,
        ref: wantRef, // matches the ledger's hashed ref for run↔row correlation
      },
    }, name);
    assert.ok(!JSON.stringify(d).includes('cs_test'), `${name} must not leak session id`);
    const custom = await mod.buildDispatch(EVENT, 'my_type');
    assert.equal(custom.event_type, 'my_type', name);
  }
});

// --- Full handler, fetch stubbed (no network) -------------------------------

const ENV = { STRIPE_WEBHOOK_SECRET: SECRET, GITHUB_TOKEN: 'ghp_testtoken', GITHUB_REPO: 'o/ops' };

function postReq(body, header) {
  return new Request('http://relay.test/', {
    method: 'POST',
    headers: header ? { 'stripe-signature': header } : {},
    body,
  });
}

async function withFetchStub(status, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { status };
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = orig;
  }
}

test('handler: verified sale → repository_dispatch POST → 200', async () => {
  const t = Math.floor(Date.now() / 1000); // handler uses the real clock
  for (const [name, mod] of Object.entries(await relays)) {
    const { result, calls } = await withFetchStub(204, () =>
      mod.handleWebhook(postReq(BODY, sigHeader(BODY, { t })), ENV));
    assert.equal(result.status, 200, name);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].url, 'https://api.github.com/repos/o/ops/dispatches', name);
    assert.equal(calls[0].init.method, 'POST', name);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ghp_testtoken', name);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.event_type, 'honorbox_sale', name);
    assert.equal(sent.client_payload.event, 'checkout.session.completed', name);
    assert.equal(sent.client_payload.ref.length, 10, name);
  }
});

test('handler: tampered request → 400 and GitHub is never called', async () => {
  const t = Math.floor(Date.now() / 1000);
  const tampered = BODY.replace('cs_test_abc123', 'cs_test_evil99');
  for (const [name, mod] of Object.entries(await relays)) {
    for (const req of [
      postReq(tampered, sigHeader(BODY, { t })), // body swapped after signing
      postReq(BODY, sigHeader(BODY, { secret: 'whsec_wrong', t })), // forged sig
      postReq(BODY, null), // unsigned
    ]) {
      const { result, calls } = await withFetchStub(204, () => mod.handleWebhook(req, ENV));
      assert.equal(result.status, 400, name);
      assert.equal(calls.length, 0, `${name}: dispatch must not fire`);
    }
  }
});

test('handler: irrelevant event types are acked without a dispatch', async () => {
  const t = Math.floor(Date.now() / 1000);
  const other = JSON.stringify({ ...EVENT, type: 'invoice.paid' });
  for (const [name, mod] of Object.entries(await relays)) {
    const { result, calls } = await withFetchStub(204, () =>
      mod.handleWebhook(postReq(other, sigHeader(other, { t })), ENV));
    assert.equal(result.status, 200, name);
    assert.equal(calls.length, 0, name);
  }
});

test('handler: GitHub dispatch failure → 502 so Stripe retries', async () => {
  const t = Math.floor(Date.now() / 1000);
  for (const [name, mod] of Object.entries(await relays)) {
    const { result } = await withFetchStub(401, () =>
      mod.handleWebhook(postReq(BODY, sigHeader(BODY, { t })), ENV));
    assert.equal(result.status, 502, name);
  }
});

test('handler: unconfigured relay → 500; non-POST → 405', async () => {
  for (const [name, mod] of Object.entries(await relays)) {
    const { result } = await withFetchStub(204, () =>
      mod.handleWebhook(postReq(BODY, sigHeader(BODY)), {}));
    assert.equal(result.status, 500, name);
    const get = await mod.handleWebhook(new Request('http://relay.test/'), ENV);
    assert.equal(get.status, 405, name);
  }
});

test('valtown default export reads the process environment', async () => {
  const { valtown } = await relays;
  const t = Math.floor(Date.now() / 1000);
  const saved = {};
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const { result, calls } = await withFetchStub(204, () =>
      valtown.default(postReq(BODY, sigHeader(BODY, { t }))));
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

// The two files are deliberately self-contained copies (each must be a
// single paste-able file). This pins their cores together: edit one without
// the other and the suite goes red.
test('relay variants share an identical verification/dispatch core', async () => {
  const { cloudflare, valtown } = await relays;
  for (const fn of ['parseSignatureHeader', 'verifyStripeSignature', 'buildDispatch', 'handleWebhook']) {
    assert.equal(cloudflare[fn].toString(), valtown[fn].toString(), fn);
  }
});
