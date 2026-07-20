'use strict';
// INTEGRATION test against the REAL Stripe API, in test mode, driving real
// subscriptions through the statuses this engine classifies.
//
// Why this exists. Every other test of the subscription lane stubs `fetch` and
// feeds the mapping a subscription object that WE wrote. That proves the code
// agrees with our idea of Stripe, which is worth nothing precisely when that
// idea is wrong: a fixture cannot tell you that the price id really lives at
// `items.data[].price.id`, that a customer really becomes `past_due` rather
// than `unpaid` when a renewal cannot be collected, or that the version we pin
// still returns the fields we read. Those are answered by real subscriptions
// moving, and by nothing else.
//
// It is SKIPPED unless HONORBOX_STRIPE_TEST_KEY is set, so it never runs in CI
// and never blocks a push. It is not optional in the sense of being unimportant.
// It is optional in the sense of needing a credential.
//
//   HONORBOX_STRIPE_TEST_KEY=sk_test_... node --test scripts/test/subs-stripe-integration.test.js
//
// The key MUST be a test-mode key. A live key FAILS the run rather than skipping
// it, because the failure it prevents is creating real subscriptions on a
// production account, and a run that quietly did nothing would look identical to
// a run that passed.
//
// Two deliberate choices about how the statuses are reached:
//
//   No raw card numbers. Stripe's testing guide says plainly, "When writing test
//   code, use a PaymentMethod such as pm_card_visa instead of a card number. We
//   don't recommend using card numbers directly in API calls or server-side
//   code, even in testing environments." Only `pm_card_visa` is used here.
//
//   past_due and paused are reached with NO payment method at all, via
//   trial_settings.end_behavior.missing_payment_method. A trial that ends with
//   nothing to charge produces exactly the states we care about, without
//   depending on the id of a decline-simulating token. Fewer magic strings,
//   and every parameter used here was read off Stripe's published OpenAPI
//   schema rather than remembered.
//
// Everything is created under a Test Clock. Deleting the clock deletes the
// customers and subscriptions on it; the Product and Price are not attached to
// a clock, so they are deactivated separately in the same cleanup.
const test = require('node:test');
const assert = require('node:assert');

const {
  subscriptionAction, desiredEntitlements, diffEntitlements, GRANT, HOLD, LAPSE,
} = require('../lib/subs-core.js');

const KEY = process.env.HONORBOX_STRIPE_TEST_KEY;
const LIVE_KEY_GIVEN = !!KEY && !KEY.startsWith('sk_test_');
const SKIP = !KEY || LIVE_KEY_GIVEN
  ? 'set HONORBOX_STRIPE_TEST_KEY to an sk_test_ key to run this'
  : false;

// Several clock advances, each a real background job on Stripe's side.
const TEST_TIMEOUT_MS = 20 * 60 * 1000;
const CLOCK_READY_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 3 * 60 * 1000;
const HOUR = 3600;
const DAY = 86400;

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
  const body = params ? encode(params) : undefined;
  const url = `https://api.stripe.com${pathname}`;
  const res = await fetch(method === 'GET' && body ? `${url}?${body}` : url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(KEY + ':').toString('base64')}`,
      // The same version the reconciler pins. If a field this engine reads ever
      // stops being returned on this version, this is where it shows.
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

// Advancing a clock is asynchronous: the call returns at once and the billing
// engine catches up behind it.
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

// Stripe settles invoices a moment after the clock reports ready, so a status
// read straight after an advance can still catch the previous one.
async function waitForStatus(subId, wanted) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let last = null;
  for (;;) {
    const sub = await stripe('GET', `/v1/subscriptions/${subId}`);
    last = sub.status;
    if (sub.status === wanted) return sub;
    if (Date.now() > deadline) throw new Error(`subscription ${subId} was ${last} after ${STATUS_TIMEOUT_MS}ms, expected ${wanted}`);
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

test('real subscriptions carry the shape and statuses this engine reads', { timeout: TEST_TIMEOUT_MS, skip: SKIP }, async (t) => {
  const REPO = 'acme/widget';
  const USER = 'octocat';
  let clockId = null;
  let priceId = null;
  let productId = null;

  try {
    const start = Math.floor(Date.now() / 1000);
    const clock = await stripe('POST', '/v1/test_helpers/test_clocks', { frozen_time: start, name: 'honorbox reconciler' });
    clockId = clock.id;

    const price = await stripe('POST', '/v1/prices', {
      currency: 'usd',
      unit_amount: 2900,
      recurring: { interval: 'month' },
      product_data: { name: 'HonorBox reconciler integration' },
    });
    priceId = price.id;
    productId = price.product;
    const grants = [{ price: price.id, product: 'Widget', repo: REPO }];

    // --- a paying customer: trialing, then active ---------------------------
    const payer = await stripe('POST', '/v1/customers', { test_clock: clockId, email: 'payer@example.com' });
    // Attaching a magic test PaymentMethod MINTS a concrete one and returns it.
    // The magic id is a factory, not a handle: naming it again produces a
    // second, unattached PaymentMethod, and setting that as the default fails
    // with "the payment method must be attached to the customer". Use what the
    // attach call handed back. Stripe's Billing testing guide says exactly this:
    // "With the resulting Payment Method ID, create the subscription or invoice
    // with this ID as the default_payment_method."
    const card = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: payer.id });
    assert.match(card.id, /^pm_/);
    assert.notEqual(card.id, 'pm_card_visa', 'the attach call returns a concrete PaymentMethod, not the magic id');
    await stripe('POST', `/v1/customers/${payer.id}`, { invoice_settings: { default_payment_method: card.id } });

    let paid = await stripe('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: { 0: { price: price.id } },
      trial_period_days: 7,
    });
    assert.equal(paid.status, 'trialing', 'a subscription created with a trial starts trialing');

    // Shape assertions matter as much as status ones: these are the exact paths
    // subs-core reads, checked against an object Stripe built.
    assert.ok(Array.isArray(paid.items && paid.items.data), 'items.data must be an array');
    assert.equal(paid.items.data[0].price.id, price.id, 'the price id must live at items.data[].price.id');
    assert.equal(typeof paid.customer, 'string', 'customer must be a bare id on the pinned version');
    assert.ok(paid.customer.startsWith('cus_'));
    assert.ok(paid.trial_end, 'a trialing subscription must carry trial_end');

    assert.equal(subscriptionAction(paid).action, GRANT, 'a running trial is entitled while it runs');
    t.diagnostic(`shape: customer=${typeof paid.customer} price at items.data[0].price.id=${paid.items.data[0].price.id === price.id} ` +
      `trial_end=${!!paid.trial_end} current_period_end=${!!paid.current_period_end}`);
    t.diagnostic(`trialing -> action ${subscriptionAction(paid).action}`);
    {
      const { desired, heldSubs, heldCustomers } = desiredEntitlements([paid], { [paid.id]: USER }, grants);
      assert.equal(desired.size, 1, 'a real trialing subscription resolves to one entitlement');
      assert.ok(desired.has(`${REPO}|${USER}`));
      assert.ok(heldSubs.has(paid.id));
      assert.ok(heldCustomers.has(paid.customer), 'and it protects by customer, which is what survives a re-subscription');
    }

    // --- a customer with nothing to charge: trialing, then past_due ----------
    // No payment method at all. When the trial ends Stripe raises the invoice
    // and cannot collect it, which is exactly the state a failed renewal
    // reaches, without depending on a decline-simulating token id.
    const lapser = await stripe('POST', '/v1/customers', { test_clock: clockId, email: 'lapser@example.com' });
    let dunning = await stripe('POST', '/v1/subscriptions', {
      customer: lapser.id,
      items: { 0: { price: price.id } },
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
    });
    assert.equal(dunning.status, 'trialing');

    // --- a customer whose trial fizzles into paused -------------------------
    const pauser = await stripe('POST', '/v1/customers', { test_clock: clockId, email: 'pauser@example.com' });
    let paused = await stripe('POST', '/v1/subscriptions', {
      customer: pauser.id,
      items: { 0: { price: price.id } },
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
    });
    assert.equal(paused.status, 'trialing');

    // --- run every trial out at once ----------------------------------------
    await advanceClockTo(clockId, start + 7 * DAY + HOUR);

    paid = await waitForStatus(paid.id, 'active');
    assert.equal(subscriptionAction(paid).action, GRANT, 'a paid subscription is entitled');
    assert.ok(paid.current_period_end, 'the pinned version must still return current_period_end on the subscription');
    t.diagnostic(`active -> action ${subscriptionAction(paid).action}`);

    dunning = await waitForStatus(dunning.id, 'past_due');
    // The single most important assertion in this file. Stripe is still
    // retrying, so this customer has not left and must not start a grace clock.
    assert.equal(subscriptionAction(dunning).action, HOLD, 'past_due must be a HOLD, never a lapse');
    t.diagnostic(`past_due -> action ${subscriptionAction(dunning).action} (reason ${JSON.stringify(subscriptionAction(dunning).reason)})`);
    {
      const { desired, heldSubs, heldCustomers } = desiredEntitlements([dunning], { [dunning.id]: USER }, grants);
      assert.equal(desired.size, 0, 'a past_due subscription grants nothing new');
      assert.ok(heldSubs.has(dunning.id), 'and it protects what it already granted');

      const records = { [`${REPO}|${USER}`]: { sub: dunning.id, customer: dunning.customer, repo: REPO, user: USER, lapsed_since: null } };
      const diff = diffEntitlements(desired, records, { heldSubs, heldCustomers, knownRepos: new Set([REPO]) });
      assert.equal(diff.due.length, 0, 'a real past_due customer is never due for revocation');
      assert.equal(diff.lapsing.length, 0, 'and no grace clock may start for them');
    }

    paused = await waitForStatus(paused.id, 'paused');
    // Empirically settles the question the mapping hedges on. If
    // `status_details` really is absent on this API version, a paused
    // subscription cannot be told apart from a seller-requested pause, so the
    // engine keeps access and warns. Asserting the real object here is the only
    // way to know which branch production actually takes.
    const pausedVerdict = subscriptionAction(paused);
    assert.equal(pausedVerdict.action, HOLD, 'an ambiguous pause keeps access');
    // Pinned as an assertion because the mapping's shape depends on it. If a
    // future API version starts returning status_details, this goes red and
    // whoever sees it can enable the cause-splitting branch that is currently
    // unreachable. That is the good direction for this to fail in.
    assert.equal(paused.status_details, undefined,
      'status_details is absent on 2024-06-20, which is why the paused cause cannot be determined');
    assert.equal(paused.pause_collection, null,
      'a trial that fizzled sets no pause_collection, so it cannot be told from a seller pause');
    assert.equal(pausedVerdict.warn, true, 'so it holds access and asks a human to look');
    t.diagnostic(`paused -> action ${pausedVerdict.action}, warn=${pausedVerdict.warn}, ` +
      `status_details ${paused.status_details === undefined ? 'ABSENT' : 'PRESENT'}, ` +
      `pause_collection ${paused.pause_collection === null ? 'null' : 'set'}`);

    // --- canceled ------------------------------------------------------------
    const cancelled = await stripe('DELETE', `/v1/subscriptions/${paid.id}`);
    assert.equal(cancelled.status, 'canceled');
    assert.equal(subscriptionAction(cancelled).action, LAPSE, 'a cancelled subscription is a lapse');
    t.diagnostic(`canceled -> action ${subscriptionAction(cancelled).action}`);
    {
      const { desired, heldSubs, heldCustomers } = desiredEntitlements([cancelled], { [cancelled.id]: USER }, grants);
      assert.equal(heldSubs.has(cancelled.id), false, 'a cancelled subscription protects nothing');
      assert.equal(heldCustomers.has(cancelled.customer), false);

      const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
      const records = { [`${REPO}|${USER}`]: { sub: cancelled.id, customer: cancelled.customer, repo: REPO, user: USER, lapsed_since: long_ago } };
      const diff = diffEntitlements(desired, records, { heldSubs, heldCustomers, knownRepos: new Set([REPO]) });
      assert.equal(diff.due.length, 1, 'a real cancellation past grace is due for revocation');
    }

    // --- incomplete ----------------------------------------------------------
    const incomplete = await stripe('POST', '/v1/subscriptions', {
      customer: lapser.id,
      items: { 0: { price: price.id } },
      payment_behavior: 'default_incomplete',
    });
    assert.equal(incomplete.status, 'incomplete');
    assert.equal(subscriptionAction(incomplete).action, HOLD,
      'incomplete is inside the first-payment window: nothing to grant, nothing to take away');
    t.diagnostic(`incomplete -> action ${subscriptionAction(incomplete).action}`);

    // --- status=all, which is what makes a cancellation visible at all -------
    //
    // Read honestly: this CANNOT exercise listAllSubscriptions' own request.
    // Stripe's test-clock documentation is explicit that list methods omit
    // objects generated by test clocks unless the query names a parent, so the
    // unfiltered enumeration the reconciler performs would return none of these
    // no matter how it were written. What this does prove is the part that is
    // portable: that `status=all` is required to see a cancelled subscription,
    // and that omitting it hides exactly the population we revoke on.
    const withAll = await stripe('GET', '/v1/subscriptions', {
      limit: 100, status: 'all', customer: payer.id, test_clock: clockId,
    });
    assert.ok(withAll.data.some((s) => s.id === cancelled.id),
      'status=all must return the cancelled subscription');
    const withoutAll = await stripe('GET', '/v1/subscriptions', {
      limit: 100, customer: payer.id, test_clock: clockId,
    });
    assert.equal(withoutAll.data.some((s) => s.id === cancelled.id), false,
      'and the default omits it, which is why status=all is not optional');

    t.diagnostic('observed on real objects: trialing, active, past_due, paused, canceled, incomplete');
  } finally {
    // The clock takes its customers and subscriptions with it. The product and
    // price are not attached to a clock, so they would otherwise pile up one
    // pair per run; prices cannot be deleted, only archived.
    //
    // ORDER MATTERS. Creating a price with `product_data` makes it that
    // product's default_price, and Stripe refuses to archive a price while it
    // holds that role: "This price cannot be archived because it is the default
    // price of its product." Archiving the PRODUCT first releases it. Verified
    // against the real test API, in that order, on the residue of the run that
    // first hit this.
    for (const [method, pathname, params] of [
      ['DELETE', clockId && `/v1/test_helpers/test_clocks/${clockId}`, null],
      ['POST', productId && `/v1/products/${productId}`, { active: false }],
      ['POST', priceId && `/v1/prices/${priceId}`, { active: false }],
    ]) {
      if (!pathname) continue;
      try {
        await stripe(method, pathname, params);
      } catch (err) {
        console.error(`WARN: cleanup failed for ${pathname}: ${err.message}. Remove it from the Stripe dashboard.`);
      }
    }
  }
});
