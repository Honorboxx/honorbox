// Repository-invitation renewal: pure logic, no network.
//
// fulfill.js's job ends when GitHub answers 201. The buyer's access begins
// when they ACCEPT. Between those two points every system a seller owns reads
// "delivered": Stripe says paid, the ledger has a row, the run is green. If the
// buyer never opens the email, that stays true right up to the moment GitHub
// expires the invitation. Then they have nothing, permanently, with nothing
// anywhere saying so. They paid.
//
// Re-issuing an invitation restarts its clock, so an invitation can be held
// open for as long as we are willing to keep emailing. That is the whole
// feature: plan the re-issues here, perform them in
// scripts/renew-invites.js.
//
// A note on where this sits. HonorBox Pro's ops bots sweep invitations too, and
// they carry the reporting: continuous triage of every pending invitation,
// pairing invitations back to the money, watchdog integration. Renewal itself
// belongs here in the free engine, because an invitation that lapses unaccepted
// means the sale was never delivered, and delivering the sale is the free
// engine's entire promise. Do not run both lanes against the same product
// repos: they would each renew, doubling the emails a buyer gets.
//
// The entitlement primitives come from access-record.js and are NOT reimplemented
// here. That module's header explains why in full; the short version is that
// "has this person's access been deliberately taken away" must have exactly one
// answer, and a second copy of that record is a revocation one lane can write
// and another cannot see.
'use strict';

const { inviteKey, findRecord, capRecords } = require('./access-record.js');

// GitHub's published window is SEVEN DAYS, and it is a starting assumption
// here, never a fact this code depends on.
//
// Cited rather than remembered, because the REST reference does not state it
// anywhere. GitHub's changelog "Self-expiring repository and organization
// invitations" (2020-02-05, https://github.blog/changelog/2020-02-05-self-
// expiring-repository-and-organization-invitations/) says "Invitations to join
// an organization or become a collaborator on a repository will expire seven
// days after they are created". That sentence covers repository collaborators
// explicitly, which matters because the docs pages it links to no longer
// restate it and the OpenAPI description of the invitation's own `expired`
// flag is just "Whether or not the invitation has expired", with no period.
//
// So the number is published but it is not part of the API contract, which
// means GitHub can shorten it without telling anyone and every store running
// this would renew too late, silently, forever. A paid access path must not
// hinge on that. The engine therefore treats seven days as the window until
// GitHub itself demonstrates otherwise, and revises DOWNWARD from GitHub's own
// `expired` flag: see renewalThresholdHours and learnExpiry below.
const DOCUMENTED_EXPIRY_HOURS = 7 * 24;

// How far ahead of the window an invitation is re-issued.
//
// The margin has to cover the worst case for "the renewal step never ran",
// because renewing late is the one failure that costs the buyer everything.
// The step rides the fulfillment poll, which the shipped template schedules
// every 30 minutes: 48 attempts inside a 24-hour margin. GitHub's cron is
// documented as best-effort and drops scheduled runs on quiet repositories, so
// the margin is sized for a scheduler that mostly does not fire. Even at a one
// in five fire rate the chance of no run at all across the margin is 0.79^48,
// about one in eighty thousand, before counting the optional heartbeat and
// on-sale dispatchers.
//
// Renewing earlier would buy margin we do not need and pay for it in buyer
// emails, which is the scarcer resource: every renewal is another message to
// somebody who has already ignored one.
const RENEWAL_MARGIN_HOURS = 24;

// The standing cadence: six days, a full day before a seven-day window lapses.
// This is the ceiling, not the rule. A store that has watched GitHub expire an
// invitation sooner renews sooner, permanently.
const REINVITE_AFTER_HOURS = DOCUMENTED_EXPIRY_HOURS - RENEWAL_MARGIN_HOURS;

// Four emails total (the original invite plus three renewals) spread over about
// 24 days, then we stop and say so. A buyer who has ignored four invitations
// across three and a half weeks is not going to be rescued by a fifth; at that
// point the honest move is to put it in front of the seller, who can email them
// properly or refund them.
const MAX_REINVITES = 3;

// A renewal is normally paced by REINVITE_AFTER_HOURS all by itself, because a
// fresh invitation resets the age this planner reads. This floor is the belt to
// that braces: if a re-issued invitation ever came back reading OLD, the age
// test alone would fire again on the very next poll and burn the whole
// allowance in an afternoon. Nothing renews twice inside a day.
const REINVITE_COOLDOWN_HOURS = 24;

// The two state fields this module reads, named once, here.
//
// `revoked_access` is not this program's own field. It is the shared denylist on
// the ops state file, written by the subscription reconciler and, on Pro, by the
// refund guard. Everything that reads or writes it goes through this constant
// and through access-record.js, so a rename moves every side together. This is
// not fussiness. The ops lane shipped a planner that destructured `revokedAccess`
// while the state on disk said `revoked_access`; the denylist read as permanently
// empty and a refunded buyer was re-invited. Every unit test passed, because each
// one handed the planner the name the planner already believed in.
const REVOKED_FIELD = 'revoked_access';
const REINVITES_FIELD = 'reinvites';

// The shortest age, in hours, at which GitHub has been seen to expire an
// invitation on this store. Absent until GitHub proves the window is shorter
// than its published one, which on a healthy store is never.
const EXPIRY_FIELD = 'invite_expiry_hours';

function ageHours(inv, now) {
  const created = Date.parse(inv && inv.created_at);
  if (!Number.isFinite(created)) return null; // unparseable: the caller decides
  return (now - created) / 3_600_000;
}

// --- what GitHub actually does, as opposed to what it published ------------

// The shortest age at which GitHub has been caught calling an invitation
// `expired`. That age is an UPPER bound on the real window, because we can only
// notice on the next poll and it therefore reads at most one poll interval too
// long. Over-reading is the safe direction, and taking the minimum across
// sightings converges on the truth from above.
//
// Read from the raw list, before grouping: a duplicate, or an invitation
// belonging to a buyer whose access was revoked, is still GitHub telling us
// when it expires things.
function observedExpiryHours(invitations, now = Date.now()) {
  let shortest = null;
  for (const inv of Array.isArray(invitations) ? invitations : []) {
    if (!inv || inv.expired !== true) continue;
    const age = ageHours(inv, now);
    if (!Number.isFinite(age) || age <= 0) continue; // unparseable, or a clock ahead of ours
    if (shortest === null || age < shortest) shortest = age;
  }
  return shortest;
}

// When to re-issue, given what this store has observed.
//
// With no observation this is the standing six days, so a store running today
// behaves exactly as it did. With one, the cadence is the observed window minus
// the same margin, so the margin scales with the window instead of being a day
// subtracted from a number nobody controls.
//
// Both ends are clamped. Never later than the standing cadence, so a freak
// long reading cannot loosen renewal. Never inside the cooldown, so a freak
// short one cannot turn renewal into a mail loop: at that floor renewal is
// re-issuing as fast as it is ever willing to email, and if the window is
// genuinely shorter than that, no cadence saves the buyer and the run says so.
function renewalThresholdHours(observed) {
  const obs = Number(observed);
  const observedWindow = Number.isFinite(obs) && obs > 0 ? obs : DOCUMENTED_EXPIRY_HOURS;
  return Math.max(REINVITE_COOLDOWN_HOURS, Math.min(REINVITE_AFTER_HOURS, observedWindow - RENEWAL_MARGIN_HOURS));
}

// Fold a sighting into what the store already believes.
//
// Only a sighting SHORTER than the current belief changes anything, and that is
// the whole point: an invitation that expired at seven days says our cadence
// was fine and something else went wrong (the step did not run, the token was
// refused), and tightening the cadence would not have helped. An invitation
// that expired at three days says the published window is not the window here,
// and every buyer after this one must be renewed sooner.
//
// `tightened` is what the caller turns into a warning. It is true exactly once
// per new low, so learning stays an event rather than a line the log repeats
// for the rest of the repository's life.
function learnExpiry(current, observed) {
  const cur = Number(current);
  const held = Number.isFinite(cur) && cur > 0 ? cur : null;
  const obs = Number(observed);
  if (!Number.isFinite(obs) || obs <= 0) return { hours: held, tightened: false };
  if (obs >= (held === null ? DOCUMENTED_EXPIRY_HOURS : held)) return { hours: held, tightened: false };
  return { hours: obs, tightened: true };
}

// --- renewal planning -------------------------------------------------------

// What to do about every pending invitation on one repo. Pure: the caller owns
// the HTTP and the clock.
//
//   reinvite    re-issue, the clock is nearly out
//   giveUp      allowance spent; stop, and say so where the seller will see it
//   cleanup     we re-invited somebody whose access was revoked underneath us;
//               undo it (see below)
//   blocked     revoked, and not our doing; leave it entirely alone
//   superseded  litter from a crash between our add and our remove; sweep it
//
// Order matters. Revocation is checked FIRST and has no exceptions, because the
// failure it prevents is the expensive one: an auto-renewal that quietly
// restores a refunded buyer is refund fraud we would have built ourselves.
//
// The narrow case worth spelling out is `cleanup`. Revocation is a separate
// command a seller runs while a scheduled poll may already be in flight, so a
// run can read the invitation list a moment before the revocation lands and
// then re-invite a buyer who is by then refunded. The denylist stops it
// happening again but cannot un-send it, so the invitation has to come back
// off. It is deleted ONLY when our own record shows we created it after the
// revocation. An invitation older than the revocation, or one we never touched,
// belongs to somebody else's decision (most likely fulfillment serving a
// re-purchase) and is left alone. We reverse our own mistakes, not other
// people's choices.
function planInviteActions(repo, invitations, state, { now = Date.now() } = {}) {
  const revokedAccess = state && state[REVOKED_FIELD];
  // Refusing to plan is the correct answer to an unreadable denylist. A
  // guard that cannot read its input must never report that everything is
  // fine, and "no denylist field" is indistinguishable from "nobody is
  // revoked" only if you decide it is. The loader normalizes a fresh install
  // to [], so reaching this means a caller built the state some other way and
  // is one rename away from re-inviting refunded buyers.
  //
  // The asymmetry with `reinvites` below is deliberate: losing the renewal
  // ledger costs a buyer one extra email, losing the denylist costs a refund.
  if (!Array.isArray(revokedAccess)) {
    throw new Error(
      `planInviteActions: state.${REVOKED_FIELD} must be an array, got ${typeof revokedAccess}; ` +
        'refusing to plan renewals against a revocation list I cannot read'
    );
  }
  const reinvites = state[REINVITES_FIELD];
  // What GitHub does here, not what GitHub published. `observed` is this
  // sweep's sighting for the caller to fold into the store's record; `threshold`
  // is the cadence every age test below is measured against.
  const observed = observedExpiryHours(invitations, now);
  const thresholdHours = renewalThresholdHours(state[EXPIRY_FIELD]);
  const plan = {
    reinvite: [], giveUp: [], cleanup: [], blocked: [], superseded: [],
    observedExpiryHours: observed,
    thresholdHours,
  };

  // Group by buyer before deciding anything. One buyer can end up holding two
  // pending invitations (we add before we remove, so a crash in between leaves
  // the spare behind on purpose), and per-invitation decisions would then email
  // them once per duplicate: the exact spam this feature must not become. The
  // newest invitation is the buyer's real one; the rest are litter to sweep up
  // silently, because no buyer needs to hear about our crash.
  const byKey = new Map();
  for (const inv of Array.isArray(invitations) ? invitations : []) {
    const login = inv && inv.invitee && inv.invitee.login;
    if (!inv || inv.id == null || !login) continue;
    const key = inviteKey(repo, login);
    if (!byKey.has(key)) byKey.set(key, { key, login, rows: [] });
    byKey.get(key).rows.push(inv);
  }

  for (const { key, login, rows } of byKey.values()) {
    const rec = findRecord(reinvites, key);

    const revoked = findRecord(revokedAccess, key);
    if (revoked) {
      // Revocation covers every invitation this buyer holds on this repo, not
      // just the newest, or a duplicate would survive the cleanup.
      for (const inv of rows) {
        const entry = { inv, key, login, repo };
        if (rec && Number(rec.last) > Number(revoked.ts)) plan.cleanup.push({ ...entry, revokedAt: revoked.ts });
        else plan.blocked.push(entry);
      }
      continue;
    }

    const dated = rows.map((inv) => ({ inv, at: Date.parse(inv.created_at) }));
    const readable = dated.filter((d) => Number.isFinite(d.at));
    // All unreadable: guessing which of two undated rows is current is exactly
    // the kind of guess that deletes the wrong one.
    if (!readable.length) continue;
    readable.sort((a, b) => b.at - a.at);
    const inv = readable[0].inv;
    for (const d of [...readable.slice(1), ...dated.filter((x) => !Number.isFinite(x.at))]) {
      plan.superseded.push({ inv: d.inv, key, login, repo });
    }
    const entry = { inv, key, login, repo };

    const age = ageHours(inv, now);
    if (inv.expired !== true && age < thresholdHours) continue;

    const n = rec ? Number(rec.n) || 0 : 0;
    if (rec && rec.gave_up) continue; // already reported, stay quiet
    if (n >= MAX_REINVITES) { plan.giveUp.push({ ...entry, n }); continue; }
    if (rec && now - Number(rec.last || 0) < REINVITE_COOLDOWN_HOURS * 3_600_000) continue;

    plan.reinvite.push({ ...entry, attempt: n + 1 });
  }
  return plan;
}

// Write down what just happened to this (repo, buyer).
//
// `n` is the email allowance and only moves when an email was actually sent, so
// a renewal GitHub refused costs the buyer nothing. `last` moves either way,
// which is what stops a permanently failing renewal from retrying on every
// poll forever: a refusal buys a day of quiet, not a spend.
//
// Both live on the (repo, buyer) key rather than the invitation id, because
// re-issuing CHANGES the id. Counting by id would hand every renewal a fresh
// allowance and email the buyer until one of them died.
//
// `gave_up` is sticky, and it is what keeps the give-up line an event rather
// than a thing the log repeats every poll for the rest of the repo's life.
function recordReinvite(rows, key, { now = Date.now(), sent = false, gaveUp = false } = {}) {
  const rec = findRecord(rows, key) || { n: 0, gave_up: false };
  const kept = (Array.isArray(rows) ? rows : []).filter((r) => r && r.key !== key);
  return capRecords([
    ...kept,
    {
      key,
      n: (Number(rec.n) || 0) + (sent ? 1 : 0),
      last: now,
      gave_up: !!(rec.gave_up || gaveUp),
    },
  ]);
}

// The buyer is in: drop the allowance so a later purchase of another product,
// or a later lapse and return, starts from a clean sheet.
function forgetReinvites(rows, key) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.key !== key);
}

// The two outcomes that need a person. Giving up is a buyer who paid and is
// about to have nothing; an undone resurrection is somebody holding access they
// refunded. Successful renewals are not alerts and are logged by the caller.
function reinviteAlertLines(repo, plan) {
  const lines = [];
  for (const g of plan.giveUp) {
    lines.push(
      `WARN: giving up on re-inviting ${g.login} to ${repo} after ${g.n} renewals ` +
        `(created ${g.inv.created_at}): they paid, have never accepted, and this invitation will now be ` +
        `allowed to expire; email them or refund them`
    );
  }
  for (const c of plan.cleanup) {
    lines.push(
      `WARN: revoked access reappeared for ${c.login} on ${repo}: a renewal raced this buyer's revocation, ` +
        `deleting invitation ${c.inv.id}`
    );
  }
  return lines;
}

// GitHub expires invitations sooner here than it says it does. Said once, when
// it is learned, because it changes how every future buyer is treated and
// because it is the only place anybody will ever find the real number.
function expiryLearnedLine(repo, observedHours, thresholdHours) {
  const at = observedHours.toFixed(1);
  const now = thresholdHours.toFixed(1);
  const floored = thresholdHours <= REINVITE_COOLDOWN_HOURS && observedHours - RENEWAL_MARGIN_HOURS < REINVITE_COOLDOWN_HOURS;
  return (
    `WARN: GitHub expired an invitation on ${repo} after ${at}h, sooner than the ${REINVITE_AFTER_HOURS}h ` +
    `renewal cadence and sooner than the seven days it publishes. Renewal now re-issues at ${now}h on this store` +
    (floored
      ? ', which is the closest spacing it will ever email a buyer at: a window this short cannot be renewed ' +
        'ahead of reliably, so check pending invitations by hand'
      : '. Buyers whose invitation lapsed are re-issued one on this run') +
    '.'
  );
}

module.exports = {
  DOCUMENTED_EXPIRY_HOURS,
  RENEWAL_MARGIN_HOURS,
  REINVITE_AFTER_HOURS,
  MAX_REINVITES,
  REINVITE_COOLDOWN_HOURS,
  REVOKED_FIELD,
  REINVITES_FIELD,
  EXPIRY_FIELD,
  ageHours,
  observedExpiryHours,
  renewalThresholdHours,
  learnExpiry,
  expiryLearnedLine,
  planInviteActions,
  recordReinvite,
  forgetReinvites,
  reinviteAlertLines,
};
