// "Has this person's access been deliberately taken away?"
//
// There is exactly ONE answer to that question and it lives here, in the
// `revoked_access` list on the ops state file. Two things write it, the refund
// guard and the subscription reconciler, and one thing reads it, the invitation
// renewal planner. All three go through these functions.
//
// That single-implementation rule is not tidiness. The renewal planner once
// read `revokedAccess` while the state on disk stored `revoked_access`, so the
// denylist was silently empty and a refunded buyer was auto-invited straight
// back in. Every unit test passed, because each one handed the planner the tidy
// name. A second implementation of this record, anywhere, recreates that bug in
// a new place: one writer would record a revocation the other could not see,
// and the gap between them is refund fraud we would have built ourselves.
//
// So these primitives live in the engine, where every program that revokes can
// reach them, rather than beside the sweep that happens to read them.
'use strict';

// One buyer, one repo. GitHub logins are case-insensitive and a repo is written
// however the config happened to spell it, so both are folded: `Octocat` and
// `octocat` on `Acme/Widget` and `acme/widget` are one person holding one
// entitlement, and must not get two allowances or slip past one revocation.
function inviteKey(repo, login) {
  return `${String(repo == null ? '' : repo).toLowerCase()}#${String(login == null ? '' : login).toLowerCase()}`;
}

function findRecord(rows, key) {
  return (Array.isArray(rows) ? rows : []).find((r) => r && r.key === key) || null;
}

// Newest-first cap, applied to both record lists. These grow one entry per
// buyer per repo and are committed to git on every cycle, so they get the same
// ceiling treatment as processed/failures in the fulfillment state.
function capRecords(rows, cap = 500) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length <= cap) return list;
  return [...list].sort((a, b) => (b.ts || b.last || 0) - (a.ts || a.last || 0)).slice(0, cap);
}

// Access was deliberately taken away from this buyer on this repo. The refund
// guard writes one of these for every repo it revokes, the subscription
// reconciler writes one for every lapse it enforces, and the renewal planner
// treats it as absolute.
//
// The record carries a timestamp rather than being a bare membership set for
// two reasons. It lets the planner tell OUR OWN post-revocation re-invite (a
// race it must undo) from an invitation created later by a legitimate
// re-purchase (which it must not touch). And it is the shape a lapse/restore
// lane needs: adding a `state` field later resolves through the same
// latest-record-per-key merge, with no change to how collisions are settled.
function recordRevocation(rows, repo, login, ts = Date.now()) {
  const key = inviteKey(repo, login);
  const kept = (Array.isArray(rows) ? rows : []).filter((r) => r && r.key !== key);
  return capRecords([...kept, { key, ts }]);
}

function revocationFor(rows, key) {
  return findRecord(rows, key);
}

module.exports = { inviteKey, findRecord, capRecords, recordRevocation, revocationFor };
