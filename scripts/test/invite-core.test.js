'use strict';
// Pure-logic tests for scripts/lib/invite-core.js.
//
// These prove the renewal decisions. They deliberately do NOT prove that the
// planner and the state file on disk agree about what the revocation list is
// called: a unit test hands the planner an object it built itself, so it can
// only ever confirm that the planner agrees with the test. That is exactly how
// the ops lane once shipped a silently-empty denylist. The proof lives in
// renew-invites-driver.test.js, through a real file.
//
// Run: node --test scripts/test/invite-core.test.js
const test = require('node:test');
const assert = require('node:assert');

const {
  DOCUMENTED_EXPIRY_HOURS,
  EXPIRY_NEWS_TOLERANCE_HOURS,
  RENEWAL_MARGIN_HOURS,
  REINVITE_AFTER_HOURS,
  MAX_REINVITES,
  REINVITE_COOLDOWN_HOURS,
  REVOKED_FIELD,
  EXPIRY_FIELD,
  observedExpiryHours,
  renewalThresholdHours,
  learnExpiry,
  planInviteActions,
  recordReinvite,
  forgetReinvites,
  reinviteAlertLines,
} = require('../lib/invite-core.js');
// The entitlement primitives are the engine's single copy, shared with the
// subscription reconciler. Renewal is their first reader, so the last two tests
// in this file are also their first direct coverage.
const { inviteKey, capRecords, recordRevocation } = require('../lib/access-record.js');

const REPO = 'o/r';
const NOW = Date.parse('2026-07-20T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const inv = (id, login, h, over = {}) => ({ id, invitee: { login }, created_at: hoursAgo(h), ...over });
const freshState = (over = {}) => ({ revoked_access: [], reinvites: [], ...over });
const plan = (invitations, state = freshState()) => planInviteActions(REPO, invitations, state, { now: NOW });

test('an unreadable revocation list refuses to plan instead of reading as "nobody is revoked"', () => {
  // The structural half of the fix. A caller that builds state some other way
  // (a tidied-up field name, a partial object) must fail loudly here rather
  // than plan renewals against an empty denylist. Losing the reinvites ledger
  // costs one extra email; losing this costs a refund.
  for (const bad of [{}, { revoked_access: null }, { revoked_access: 'none' }, { revokedAccess: [] }, undefined]) {
    assert.throws(
      () => planInviteActions(REPO, [inv(1, 'buyer', 200)], bad, { now: NOW }),
      new RegExp(`state\\.${REVOKED_FIELD} must be an array`),
      `must refuse: ${JSON.stringify(bad)}`
    );
  }
  // ...and a missing reinvites ledger is tolerated, on purpose.
  assert.doesNotThrow(() => planInviteActions(REPO, [inv(1, 'buyer', 200)], { revoked_access: [] }, { now: NOW }));
});

test('a young invitation is left alone; one past the renewal age is re-issued', () => {
  assert.deepEqual(plan([inv(1, 'buyer', 1)]).reinvite, [], 'a buyer who is simply asleep is not chased');
  assert.deepEqual(plan([inv(1, 'buyer', REINVITE_AFTER_HOURS - 1)]).reinvite, [], 'not yet');
  const due = plan([inv(1, 'buyer', REINVITE_AFTER_HOURS + 1)]).reinvite;
  assert.equal(due.length, 1);
  assert.equal(due[0].login, 'buyer');
  assert.equal(due[0].attempt, 1, 'first renewal of four contacts');
});

test("GitHub's own expired flag overrides the age arithmetic", () => {
  // If GitHub says expired we believe GitHub, whatever created_at reads.
  const p = plan([inv(1, 'buyer', 2, { expired: true })]);
  assert.equal(p.reinvite.length, 1, 'an expired invitation is renewable regardless of its age');
});

// --- the window is GitHub's, and it is watched rather than assumed ----------
//
// The seven days is published (changelog, 2020-02-05) but is not part of the
// API contract: the OpenAPI description of `expired` states no period at all.
// GitHub can therefore shorten it without telling anyone, and a paid access
// path that hardcoded it would renew too late on every store, silently and
// forever. These tests pin the machinery that stops that.

test('the shortest expiry GitHub is actually seen to enforce is what gets believed', () => {
  // An expired invitation's age is an UPPER bound on the real window: we can
  // only notice on the next poll. The minimum across sightings converges on the
  // truth from above, which is the safe direction.
  assert.equal(observedExpiryHours([inv(1, 'a', 90, { expired: true }), inv(2, 'b', 70, { expired: true })], NOW), 70);
  // A duplicate, or a buyer whose access was revoked, is still GitHub telling
  // us when it expires things.
  assert.equal(observedExpiryHours([inv(1, 'a', 50, { expired: true }), inv(2, 'a', 200, { expired: true })], NOW), 50);
  // Nothing to learn from.
  assert.equal(observedExpiryHours([inv(1, 'a', 300)], NOW), null, 'a live invitation says nothing about the window');
  assert.equal(observedExpiryHours([], NOW), null);
  assert.equal(observedExpiryHours(null, NOW), null);
  assert.equal(
    observedExpiryHours([{ id: 1, invitee: { login: 'a' }, created_at: 'not a date', expired: true }], NOW),
    null,
    'an unreadable created_at is not a measurement'
  );
  assert.equal(observedExpiryHours([inv(1, 'a', -5, { expired: true })], NOW), null, 'a clock ahead of ours is not a measurement');
});

test('a sighting is a number an operator can read, not a float with the poll delay on the end', () => {
  // The age is measured whenever the poll happened to run, so the raw figure
  // carries the scheduling delay as trailing decimals. That lands in the state
  // file and in the log line, where it is noise. Floored, not rounded:
  // under-reading the window renews earlier, which is the safe direction.
  const late = { id: 1, invitee: { login: 'a' }, created_at: new Date(NOW - 60 * 3_600_000 - 1).toISOString(), expired: true };
  assert.equal(observedExpiryHours([late], NOW), 60, 'a hair over 60 hours is 60 hours');
  const bit = { id: 2, invitee: { login: 'b' }, created_at: new Date(NOW - (60.019 * 3_600_000)).toISOString(), expired: true };
  assert.equal(observedExpiryHours([bit], NOW), 60.01, 'and real precision below the hour survives');
});

test('clock skew against GitHub is not mistaken for GitHub changing its policy', () => {
  // created_at is GitHub's clock, the age is ours, and they are not the same
  // clock. A few seconds either way is normal and must not read as "the window
  // is shorter than published" on a store where nothing is wrong: that would
  // warn every seller who ever lets one invitation lapse.
  assert.deepEqual(learnExpiry(undefined, DOCUMENTED_EXPIRY_HOURS - 0.02), { hours: null, tightened: false }, 'seconds of skew');
  assert.deepEqual(
    learnExpiry(undefined, DOCUMENTED_EXPIRY_HOURS - EXPIRY_NEWS_TOLERANCE_HOURS),
    { hours: null, tightened: false },
    'right at the tolerance is still not news'
  );
  const news = DOCUMENTED_EXPIRY_HOURS - EXPIRY_NEWS_TOLERANCE_HOURS - 0.01;
  assert.deepEqual(learnExpiry(undefined, news), { hours: news, tightened: true }, 'past it, it is');
});

test('the cadence tracks the observed window, and is clamped at both ends', () => {
  assert.equal(renewalThresholdHours(undefined), REINVITE_AFTER_HOURS, 'no sighting: the standing six days');
  for (const junk of [null, 0, -1, 'soon', NaN]) {
    assert.equal(renewalThresholdHours(junk), REINVITE_AFTER_HOURS, `unusable sighting: ${junk}`);
  }
  assert.equal(
    renewalThresholdHours(DOCUMENTED_EXPIRY_HOURS),
    REINVITE_AFTER_HOURS,
    'the published window reproduces the shipped cadence exactly, so nothing regresses'
  );
  assert.equal(renewalThresholdHours(72), 72 - RENEWAL_MARGIN_HOURS, 'the margin scales with the window');
  // Never later than the standing cadence: a freak long reading must not be
  // able to loosen renewal.
  assert.equal(renewalThresholdHours(10_000), REINVITE_AFTER_HOURS);
  // Never inside the cooldown: a freak short one must not turn renewal into a
  // mail loop. At the floor renewal is already emailing as often as it ever will.
  assert.equal(renewalThresholdHours(30), REINVITE_COOLDOWN_HOURS);
  assert.equal(renewalThresholdHours(1), REINVITE_COOLDOWN_HOURS);
});

test('only a window SHORTER than the one we believe in changes anything', () => {
  // An invitation that expired at seven days says the cadence was fine and
  // something else went wrong (the step never ran, the token was refused).
  // Tightening on that would punish every buyer for an unrelated fault.
  assert.deepEqual(learnExpiry(undefined, DOCUMENTED_EXPIRY_HOURS), { hours: null, tightened: false });
  assert.deepEqual(learnExpiry(undefined, 300), { hours: null, tightened: false });
  assert.deepEqual(learnExpiry(undefined, 72), { hours: 72, tightened: true }, 'this one is news');
  assert.deepEqual(learnExpiry(72, 90), { hours: 72, tightened: false }, 'a looser sighting never loosens us');
  assert.deepEqual(learnExpiry(72, 48), { hours: 48, tightened: true }, 'a tighter one does');
  for (const junk of [null, undefined, 0, -3, 'soon']) {
    assert.deepEqual(learnExpiry(72, junk), { hours: 72, tightened: false }, `unusable sighting: ${junk}`);
  }
});

test('a store that has watched GitHub expire early renews on the window it saw, not the one GitHub publishes', () => {
  // The whole point, in one assertion. This invitation is younger than the
  // shipped six-day cadence, so a renewal keyed to the published number leaves
  // it alone and the buyer loses what they paid for.
  const young = [inv(1, 'buyer', 50)];
  assert.deepEqual(plan(young).reinvite, [], 'against the published window it is not due');

  const taught = freshState({ [EXPIRY_FIELD]: 72 });
  const p = plan(young, taught);
  assert.equal(p.reinvite.length, 1, 'against the window this store has actually seen, it is overdue');
  assert.equal(p.thresholdHours, 48, 'and the plan says which cadence it used');
});

test('the email allowance is spent, then it gives up and says so exactly once', () => {
  const key = inviteKey(REPO, 'buyer');
  const old = inv(1, 'buyer', REINVITE_AFTER_HOURS + 1);
  const spent = freshState({ reinvites: [{ key, n: MAX_REINVITES, last: NOW - 48 * 3_600_000, gave_up: false }] });
  const p = plan([old], spent);
  assert.deepEqual(p.reinvite, [], 'allowance spent: no more emails');
  assert.equal(p.giveUp.length, 1);
  assert.equal(p.giveUp[0].n, MAX_REINVITES);
  const line = reinviteAlertLines(REPO, p)[0];
  assert.match(line, /^WARN:/, 'a paid buyer about to lose everything is a WARN');
  assert.match(line, /giving up on re-inviting buyer/);
  assert.match(line, /email them or refund them/, 'tell the seller what to do about it');

  // Sticky: once reported, it stops being reported.
  const after = freshState({ reinvites: [{ key, n: MAX_REINVITES, last: NOW, gave_up: true }] });
  const q = plan([old], after);
  assert.deepEqual(q.giveUp, [], 'a give-up is an event, not a thing the log repeats forever');
  assert.deepEqual(q.reinvite, []);
});

test('nothing renews twice inside the cooldown, even if the invitation still reads old', () => {
  // The belt to the age test's braces. If a re-issued invitation ever came back
  // reading OLD, the age test alone would fire again on the next poll and burn
  // the whole allowance in an afternoon.
  const key = inviteKey(REPO, 'buyer');
  const old = [inv(1, 'buyer', REINVITE_AFTER_HOURS + 1)];
  const justRenewed = freshState({ reinvites: [{ key, n: 1, last: NOW - 1 * 3_600_000, gave_up: false }] });
  assert.deepEqual(plan(old, justRenewed).reinvite, [], 'inside the cooldown');
  const yesterday = freshState({ reinvites: [{ key, n: 1, last: NOW - (REINVITE_COOLDOWN_HOURS + 1) * 3_600_000, gave_up: false }] });
  assert.equal(plan(old, yesterday).reinvite.length, 1, 'a day later it may try again');
});

test('a revoked buyer is never re-invited, and case does not get them past it', () => {
  const state = freshState({ revoked_access: [{ key: inviteKey(REPO, 'Refunded'), ts: NOW - 3_600_000 }] });
  const p = plan([inv(1, 'Refunded', 200), inv(2, 'waiting', 200)], state);
  assert.deepEqual(p.reinvite.map((r) => r.login), ['waiting'], 'the refunded buyer must not be renewed');
  assert.equal(p.blocked.length, 1);

  // GitHub logins are case-insensitive, so "refunded" and "Refunded" are one
  // person and one revocation has to cover both spellings.
  const q = plan([inv(1, 'refunded', 200)], state);
  assert.deepEqual(q.reinvite, [], 'a different capitalisation is the same buyer');
  assert.equal(q.blocked.length, 1);
});

test('a revocation blocks even a buyer whose allowance is untouched and invitation is fresh', () => {
  // Revocation is checked first and has no exceptions. A fresh invitation would
  // normally be skipped as "not due"; it must land in blocked, not in nothing,
  // so the count line can report it as held back.
  const state = freshState({ revoked_access: [{ key: inviteKey(REPO, 'refunded'), ts: NOW }] });
  const p = plan([inv(1, 'refunded', 1)], state);
  assert.deepEqual(p.reinvite, []);
  assert.equal(p.blocked.length, 1);
});

test('our own post-revocation re-invite is cleaned up; somebody else\'s is left alone', () => {
  const key = inviteKey(REPO, 'refunded');
  const revokedAt = NOW - 10 * 3_600_000;
  // We re-invited AFTER the revocation: our race, our mess, we delete it.
  const ours = freshState({
    revoked_access: [{ key, ts: revokedAt }],
    reinvites: [{ key, n: 1, last: revokedAt + 60_000, gave_up: false }],
  });
  const p = plan([inv(9, 'refunded', 1)], ours);
  assert.equal(p.cleanup.length, 1, 'a renewal that raced a revocation has to come back off');
  assert.equal(p.cleanup[0].inv.id, 9);
  assert.deepEqual(p.blocked, []);
  assert.match(reinviteAlertLines(REPO, p)[0], /^WARN: revoked access reappeared for refunded/);

  // The invitation predates our last renewal record, or we never touched them:
  // somebody else decided that (most likely a re-purchase). Leave it.
  const theirs = freshState({
    revoked_access: [{ key, ts: revokedAt }],
    reinvites: [{ key, n: 1, last: revokedAt - 60_000, gave_up: false }],
  });
  const q = plan([inv(9, 'refunded', 1)], theirs);
  assert.deepEqual(q.cleanup, [], 'we reverse our own mistakes, not other people\'s choices');
  assert.equal(q.blocked.length, 1);
});

test('a buyer holding two invitations gets one email, and the spare is swept', () => {
  // We add before we remove, so a crash in between leaves a duplicate on
  // purpose. Per-invitation decisions would then email the buyer once per
  // duplicate: the exact spam this feature must not become.
  const p = plan([inv(1, 'buyer', 200), inv(2, 'buyer', 199)]);
  assert.equal(p.reinvite.length, 1, 'one buyer, one email');
  assert.equal(p.reinvite[0].inv.id, 2, 'the newest invitation is the buyer\'s real one');
  assert.deepEqual(p.superseded.map((s) => s.inv.id), [1], 'the older one is litter');
});

test('an invitation with an unreadable created_at is never guessed at', () => {
  const p = plan([{ id: 1, invitee: { login: 'buyer' }, created_at: 'not a date' }]);
  assert.deepEqual(p.reinvite, [], 'no date, no renewal decision');
  assert.deepEqual(p.superseded, [], 'and nothing gets deleted on a guess');
});

test('rows GitHub could not have meant are skipped, not crashed on', () => {
  const p = plan([null, { id: 1 }, { invitee: { login: 'x' } }, { id: 2, invitee: {} }, inv(3, 'buyer', 200)]);
  assert.deepEqual(p.reinvite.map((r) => r.login), ['buyer']);
});

test('recordReinvite spends the allowance only when an email actually went out', () => {
  const key = inviteKey(REPO, 'buyer');
  let rows = recordReinvite([], key, { now: 1000, sent: true });
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].last, 1000);
  // A renewal GitHub refused costs the buyer nothing, but still buys quiet:
  // otherwise a repo that refuses us is retried on every poll forever.
  rows = recordReinvite(rows, key, { now: 2000, sent: false });
  assert.equal(rows[0].n, 1, 'no email, no spend');
  assert.equal(rows[0].last, 2000, 'but the clock moves');
  assert.equal(rows.length, 1, 'one record per (repo, buyer), not one per attempt');
  rows = recordReinvite(rows, key, { now: 3000, gaveUp: true });
  assert.equal(rows[0].gave_up, true);
  rows = recordReinvite(rows, key, { now: 4000 });
  assert.equal(rows[0].gave_up, true, 'gave_up is sticky');
});

test('a buyer who gets in starts from a clean sheet next time', () => {
  const key = inviteKey(REPO, 'buyer');
  const rows = recordReinvite([], key, { sent: true });
  assert.deepEqual(forgetReinvites(rows, key), []);
  assert.equal(forgetReinvites(rows, inviteKey(REPO, 'someone-else')).length, 1, 'only that buyer');
});

test('recordRevocation replaces rather than duplicates, and is keyed per repo', () => {
  let rows = recordRevocation([], REPO, 'buyer', 100);
  rows = recordRevocation(rows, REPO, 'BUYER', 200);
  assert.equal(rows.length, 1, 'one revocation per (repo, buyer), latest wins');
  assert.equal(rows[0].ts, 200);
  rows = recordRevocation(rows, 'o/other', 'buyer', 300);
  assert.equal(rows.length, 2, 'refunding one product must not revoke another they still own');
});

test('record lists are capped newest-first so a busy store cannot grow them without bound', () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ key: `k${i}`, ts: i }));
  const capped = capRecords(rows, 500);
  assert.equal(capped.length, 500);
  assert.ok(capped.every((r) => r.ts >= 100), 'the oldest records are the ones dropped');
  assert.deepEqual(capRecords([{ key: 'a', ts: 1 }, null], 500), [{ key: 'a', ts: 1 }]);
});
