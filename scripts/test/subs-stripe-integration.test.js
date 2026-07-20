'use strict';
// INTEGRATION test against the REAL Stripe API, in test mode, driving one
// subscription through the transitions this engine classifies.
//
// Why this exists. Every other test of the subscription lane stubs `fetch` and
// feeds the mapping a subscription object that WE wrote. That proves the code
// agrees with our idea of Stripe, which is exactly the assumption that is worth
// nothing when it is wrong: a fixture cannot tell you that `items.data[].price`
// is where the price id really lives, that `status` really becomes `past_due`
// rather than `unpaid` when a recurring charge fails, or that the version we
// pin still returns the fields we read. Those are answered by one subscription
// actually moving, and by nothing else.
//
// It is SKIPPED unless HONORBOX_STRIPE_TEST_KEY is set, so it never runs in CI
// and never blocks a push. It is not optional in the sense of being unimportant;
// it is optional in the sense of needing a credential.
//
//   HONORBOX_STRIPE_TEST_KEY=sk_test_... node --test scripts/test/subs-stripe-integration.test.js
//
// The key MUST be a test-mode key. A live key is refused rather than skipped,
// because the failure it prevents is creating real subscription objects on a
// production account, and a run that quietly did nothing would look identical
// to a run that passed.
//
// Everything is created under a Test Clock and the clock is deleted at the end,
// which deletes the customer and every subscription with it. Nothing survives a
// completed run.
const test = require('node:test');
const assert = require('node:assert');

const { subscriptionAction, desiredEntitlements, diffEntitlements, GRANT, HOLD, LAPSE } = require('../lib/subs-core.js');

const KEY = process.env.HONORBOX_STRIPE_TEST_KEY;
const LIVE_KEY_GIVEN = !!KEY && !KEY.startsWith('sk_test_');

// A whole subscription lifecycle is several clock advances and each one is a
// real background job on Stripe's side.
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const CLOCK_READY_TIMEOUT_MS = 3 * 60 * 1000;
const HOUR = 3600;

// Documented test card that attaches to a customer successfully and then fails
// on recurring charges, which is the only honest way to reach past_due.
const CARD_FAILS_ON_RENEWAL = '4000000000000341';
const CARD_OK = '4242424242424242';

// Form-encode the way Stripe expects: items[0][price]=price_x.
function encode(params, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') out.push(encode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

async function stripe(method, pathname, params) {
  const url = `https://api.stripe.com${pathname}`;
  const body = params ? encode(params) : undefined;
  const res = await fetch(method === 'GET' && body ? `${url}?${body}` : url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(KEY + ':').toString('base64')}`,
      // The same version the reconciler pins. If a field this engine reads ever
      // stops being returned on this version, these tests are where it shows.
      'Stripe-Version': '2024-06-20',
      ...(method === 'GET' || !body ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: method === 'GET' ? undefined : body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${pathname} -> ${res.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Advancing a clock is asynchronous: the call returns immediately and the
// billing engine catches up in the background.
async function advanceClockTo(clockId, unixTime) {
  await stripe('POST', `/v1/test_helpers/test_clocks/${clockId}/advance`, { frozen_time: unixTime });
  const deadline = Date.now() + CLOCK_READY_TIMEOUT_MS;
  for (;;) {
    const clock = await stripe('GET', `/v1/test_helpers/test_clocks/${clockId}`);
    if (clock.status === 'ready') return clock;
    if (clock.status === 'internal_failure') throw new Error(`test clock ${clockId} failed internally`);
    if (Date.now() > deadline) throw new Error(`test clock ${clockId} still ${clock.status} after ${CLOCK_READY_TIMEOUT_MS}ms`);
    await sleep(2000);
  }
}

async function getSub(id) {
  return stripe('GET', `/v1/subscriptions/${id}`);
}

// Stripe settles an invoice a moment after the clock reports ready, so a status
// read immediately after an advance can catch the previous one.
async function waitForStatus(subId, wanted, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const sub = await getSub(subId);
    last = sub.status;
    if (sub.status === wanted) return sub;
    if (Date.now() > deadline) {
      throw new Error(`subscription ${subId} was ${last} after ${timeoutMs}ms, expected ${wanted}`);
    }
    await sleep(3000);
  }
}

// A live key must stop the run, not skip it silently.
test('the integration key is a test-mode key', () => {
  assert.equal(
    LIVE_KEY_GIVEN,
    false,
    'HONORBOX_STRIPE_TEST_KEY is not an sk_test_ key. This test creates subscriptions, ' +
      'customers and prices; pointed at a live key it would create them on the real account. Refusing to run.'
  );
});

test('a real subscription moves through the statuses this engine classifies', { timeout: TEST_TIMEOUT_MS, skip: !KEY || LIVE_KEY_GIVEN ? 'set HONORBOX_STRIPE_TEST_KEY to an sk_test_ key to run this' : false }, async (t) => {
  const REPO = 'acme/widget';
  const USER = 'octocat';
  let clockId = null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const clock = await stripe('POST', '/v1/test_helpers/test_clocks', { frozen_time: now, name: 'honorbox subs reconciler' });
    clockId = clock.id;

    const price = await stripe('POST', '/v1/prices', {
      currency: 'usd',
      unit_amount: 2900,
      recurring: { interval: 'month' },
      product_data: { name: 'HonorBox reconciler integration' },
    });
    const grants = [{ price: price.id, product: 'Widget', repo: REPO }];

    const customer = await stripe('POST', '/v1/customers', { test_clock: clockId, email: 'integration@example.com' });

    const goodPm = await stripe('POST', '/v1/payment_methods', {
      type: 'card',
      card: { number: CARD_OK, exp_month: 12, exp_year: new Date().getFullYear() + 3, cvc: '123' },
    });
    await stripe('POST', `/v1/payment_methods/${goodPm.id}/attach`, { customer: customer.id });
    await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: goodPm.id } });

    // --- trialing -----------------------------------------------------------
    let sub = await stripe('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: { 0: { price: price.id } },
      trial_period_days: 7,
    });
    assert.equal(sub.status, 'trialing', 'a subscription created with a trial starts trialing');

    // The shape assertions matter as much as the status ones: these are the
    // exact paths subs-core reads, checked against an object Stripe built.
    assert.ok(Array.isArray(sub.items && sub.items.data), 'items.data must be an array');
    assert.equal(sub.items.data[0].price.id, price.id, 'the price id must live at items.data[].price.id');
    assert.equal(typeof sub.status, 'string');

    assert.equal(subscriptionAction(sub).action, GRANT, 'a running trial is entitled while it runs');
    {
      const { desired, heldSubs } = desiredEntitlements([sub], { [sub.id]: USER }, grants);
      assert.equal(desired.size, 1, 'a real trialing subscription resolves to one entitlement');
      assert.ok(desired.has(`${REPO}|${USER}`));
      assert.ok(heldSubs.has(sub.id));
    }

    // --- active -------------------------------------------------------------
    await advanceClockTo(clockId, sub.trial_end + HOUR);
    sub = await waitForStatus(sub.id, 'active');
    assert.equal(subscriptionAction(sub).action, GRANT, 'a paid subscription is entitled');

    // --- past_due -----------------------------------------------------------
    // Swap in the card that fails on renewal, then run the clock past the end
    // of the paid period so Stripe actually attempts and fails a charge.
    const badPm = await stripe('POST', '/v1/payment_methods', {
      type: 'card',
      card: { number: CARD_FAILS_ON_RENEWAL, exp_month: 12, exp_year: new Date().getFullYear() + 3, cvc: '123' },
    });
    await stripe('POST', `/v1/payment_methods/${badPm.id}/attach`, { customer: customer.id });
    await stripe('POST', `/v1/subscriptions/${sub.id}`, { default_payment_method: badPm.id });

    assert.ok(sub.current_period_end, 'the pinned API version must still return current_period_end on the subscription');
    await advanceClockTo(clockId, sub.current_period_end + HOUR);
    sub = await waitForStatus(sub.id, 'past_due');

    // The single most important assertion in this file. A declined card must
    // not start a grace clock, because Stripe is still retrying it.
    const pastDueAction = subscriptionAction(sub);
    assert.equal(pastDueAction.action, HOLD, 'past_due must be a HOLD, never a lapse');
    {
      const { desired, heldSubs } = desiredEntitlements([sub], { [sub.id]: USER }, grants);
      assert.equal(desired.size, 0, 'a past_due subscription grants nothing new');
      assert.ok(heldSubs.has(sub.id), 'and it protects what it already granted');

      const records = { [`${REPO}|${USER}`]: { sub: sub.id, repo: REPO, user: USER, lapsed_since: null } };
      const diff = diffEntitlements(desired, records, { heldSubs, knownRepos: new Set([REPO]) });
      assert.equal(diff.due.length, 0, 'a real past_due customer is never due for revocation');
      assert.equal(diff.lapsing.length, 0, 'and no grace clock may start for them');
    }

    // --- canceled -----------------------------------------------------------
    sub = await stripe('DELETE', `/v1/subscriptions/${sub.id}`);
    assert.equal(sub.status, 'canceled');
    assert.equal(subscriptionAction(sub).action, LAPSE, 'a cancelled subscription is a lapse');
    {
      const { desired, heldSubs } = desiredEntitlements([sub], { [sub.id]: USER }, grants);
      assert.equal(desired.size, 0);
      assert.equal(heldSubs.has(sub.id), false, 'a cancelled subscription protects nothing');

      const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
      const records = { [`${REPO}|${USER}`]: { sub: sub.id, repo: REPO, user: USER, lapsed_since: long_ago } };
      const diff = diffEntitlements(desired, records, { heldSubs, knownRepos: new Set([REPO]) });
      assert.equal(diff.due.length, 1, 'a real cancellation past grace is due for revocation');
    }

    // --- incomplete ---------------------------------------------------------
    // A separate subscription, because incomplete is a starting state rather
    // than one the first subscription can be driven back into.
    const incomplete = await stripe('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: { 0: { price: price.id } },
      payment_behavior: 'default_incomplete',
    });
    assert.equal(incomplete.status, 'incomplete');
    assert.equal(subscriptionAction(incomplete).action, HOLD,
      'incomplete is inside the first-payment window: nothing to grant, nothing to take away');

    // --- the enumeration the reconciler actually performs --------------------
    // status=all is the parameter that makes cancellations visible at all.
    const all = await stripe('GET', '/v1/subscriptions', { limit: 100, status: 'all', customer: customer.id, test_clock: clockId });
    const ids = all.data.map((s) => s.id);
    assert.ok(ids.includes(sub.id), 'status=all must return the cancelled subscription, or nothing is ever revoked');
    assert.ok(ids.includes(incomplete.id));

    t.diagnostic(`observed statuses on real objects: trialing, active, past_due, canceled, incomplete`);
  } finally {
    // Deleting the clock deletes the customer and every subscription on it.
    if (clockId) {
      try {
        await stripe('DELETE', `/v1/test_helpers/test_clocks/${clockId}`);
      } catch (err) {
        console.error(`WARN: could not delete test clock ${clockId}: ${err.message}. Delete it from the Stripe dashboard.`);
      }
    }
  }
});
