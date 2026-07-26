// Pure fulfillment logic — no network, fully unit-testable.
// The I/O driver (fulfill.js) feeds it Stripe Checkout Session objects.
'use strict';

const crypto = require('crypto');

// Poll re-scan window. Checkout Sessions can complete up to 24h after
// creation (Stripe's expires_at ceiling), and the cursor tracks creation
// time, so the window must outlive a session: 24h + 1h slack. Re-scans are
// free (processed-id set), a missed sale is not.
const OVERLAP_SECONDS = 25 * 3600;

// Every outbound call gets a deadline. Node's fetch has no overall request
// timeout, and undici's header/body defaults are 300s each: an accepted-but-
// unanswered socket stalls the whole poll. Measured on Node 24 — a bare fetch
// against a server that accepts and never replies had still not settled after
// 8s, while AbortSignal.timeout aborts on the dot. That matters because the
// runner is a single launchd job: while one cycle is stuck on one buyer's
// invite, no other cycle starts and EVERY buyer behind them waits. An abort
// carries no .status, so it lands in the transient bucket and simply retries.
const REQUEST_TIMEOUT_MS = 20_000;

// Which Stripe account a key talks to, read off the key's own prefix. Stripe
// publishes these: `sk_live_`/`rk_live_` reach real customers and real money,
// `sk_test_`/`rk_test_` reach the test account.
//
// Worth a function because the name a store reads, STRIPE_SECRET_KEY, is an
// ordinary environment variable and nothing about it says which account is on
// the other end. A shell profile that exports the live key, a copied .env, a
// CI secret set on the wrong repo: in every case fulfillment runs against real
// buyers and looks exactly like a test run while it does it. So the run says
// which one it is, out loud, before it calls Stripe.
//
// An unrecognised prefix is 'unknown', never 'test'. A key shape we do not
// recognise is not evidence of safety, and treating it as safe is how this
// would fail in the one direction that costs money.
function stripeMode(key) {
  if (/^(sk|rk)_live_/.test(String(key || ''))) return 'live';
  if (/^(sk|rk)_test_/.test(String(key || ''))) return 'test';
  return 'unknown';
}

// Provider error bodies get logged verbatim, and Stripe quotes the key back in
// them: a 401 answers `Invalid API Key provided: sk_test_****...0000`, and a
// malformed key is echoed whole rather than masked. Those lines land in CI
// logs and in an operator's terminal, so anything key-shaped is replaced
// before the body is used in a message. The mode prefix survives on purpose,
// as `sk_live_<redacted>`: which account failed is the useful half, and it is
// the half that is not a secret.
const KEYISH_RE = /\b((?:sk|rk|pk)_(?:live|test)_)[A-Za-z0-9]+/g;

function redactKeys(text) {
  return String(text ?? '')
    .replace(KEYISH_RE, '$1<redacted>')
    // A key that never matched the shape above (a truncated paste, a wrong
    // value) is echoed by Stripe in full and cannot be recognised by prefix,
    // so the one phrase that carries it is cut at the phrase. The lookahead
    // keeps this from swallowing the prefix the rule above just preserved:
    // `sk_live_<redacted>` is itself one \S+ run.
    .replace(
      /(Invalid API Key provided:\s*)(?!(?:sk|rk|pk)_(?:live|test)_<redacted>)\S+/gi,
      '$1<redacted>'
    );
}

// GitHub username: 1-39 chars, alphanumeric + hyphen, no leading/trailing
// hyphen, no consecutive hyphens.
const USERNAME_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$/;

function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u) && !u.includes('--');
}

// --- finding the buyer on the checkout session ------------------------------
//
// WHICH CUSTOM FIELD CARRIES THE BUYER'S GITHUB USERNAME IS NOT SOMETHING THE
// SELLER NECESSARILY CHOSE, so matching one exact key was a bet on a string
// they may never have typed. Two observed facts. Stripe's API requires a unique
// `key` on every custom field, so a key always exists on the object. Stripe's
// DASHBOARD never asks for one and never shows one: its Add custom fields panel
// offers a type, a "Label name" input and a few checkboxes, and no key appears
// on the field afterwards either. A seller who built a link by clicking
// therefore cannot set the key and cannot read it. What the dashboard stores
// instead we have not measured, and nothing here guesses at it.
//
// Stores this engine built are unaffected, because init.js and add-tier.js set
// the key over the API. This is for the seller who built a link by hand, whose
// field would otherwise read as no field at all: paid orders skipped, a green
// run, and a buyer with nothing.
//
// So the field is found by signals RANKED and never pooled. The strongest one
// present decides and weaker ones are not consulted, because pooling is how a
// checkout with several fields invites whatever was typed into the wrong box,
// and an invitation to a private repo cannot be taken back.
const CANONICAL_FIELD_KEY = 'github_username';

// Lowercased letters and digits, nothing else. Case and punctuation are the
// part of a key a seller does not control, so `github_username`,
// `githubusername`, `github-username` and `GitHubUsername` reduce to one string
// while two genuinely different keys still differ.
const squashKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

// The label is the ONLY signal a dashboard-made field offers, so it does real
// work here rather than covering an edge. It is still prose written for a buyer
// to read, so it has to carry BOTH halves of the idea: the platform, and the
// thing being asked for. A bare "GitHub" does not, because "the GitHub repo you
// want" is also a field about GitHub and is not a username. The nouns are a
// short closed list of words a seller would actually write on this field.
// "name" is absent because it also ends "repository name", and two-letter
// tokens because once punctuation is gone they surface inside unrelated words
// ("paid" contains "id").
const LABEL_NOUNS = ['user', 'handle', 'account', 'login', 'profile'];

// Ranked, strongest first. The text is what a report quotes as the reason a
// field was chosen.
const FIELD_SIGNALS = ['its key', 'its key, ignoring case and separators', 'its label'];

// Which signal this field matches, or null for none.
function fieldSignal(field, wantKey) {
  const key = typeof field.key === 'string' ? field.key : '';
  if (key === wantKey) return 0;
  if (squashKey(key) === squashKey(wantKey)) return 1;
  const l = field.label;
  const label = squashKey(typeof l === 'string' ? l : (l && l.custom) || '');
  if (label.includes('github') && LABEL_NOUNS.some((n) => label.includes(n))) return 2;
  return null;
}

// Buyers type this field dirty. Trim, drop a leading @, and unwrap a BARE
// profile link, which they paste often enough to be worth accepting. Anything
// deeper than a bare profile passes through untouched so validation rejects it
// instead of the code guessing.
function cleanUsername(raw) {
  const u = String(raw).trim().replace(/^@/, '');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/?$/i.exec(u);
  return m ? m[1].replace(/^@/, '') : u;
}

// The buyer field, resolved, with what resolved it:
//   username    the cleaned value, or null when nothing resolved
//   key         the key of the field it came from
//   via         which signal matched, for a report to quote
//   ambiguous   several fields matched equally well and their values could not
//               break the tie, so nothing was chosen
//   candidates  the keys that tied, so an operator can go and fix the link
//
// REFUSING IS THE SAFE DIRECTION AND IT IS DELIBERATE. Every caller already has
// a loud branch for "no username": fulfillment files a needs-attention row, the
// reconciler prints a finding, the refund guard warns that a buyer kept access.
// Inviting the WRONG value has no such branch and no undo.
function resolveBuyerField(session, wantKey = CANONICAL_FIELD_KEY) {
  const fields = session && Array.isArray(session.custom_fields) ? session.custom_fields : [];
  const matched = [];
  for (const f of fields) {
    if (!f || typeof f !== 'object') continue;
    // No text value means nothing to invite: an unanswered field, or a numeric
    // or dropdown one, whose answer never lives at text.value. That absence is
    // read rather than the field's `type`, because it is the same fact and it
    // holds for any session shape.
    const raw = f.text && typeof f.text.value === 'string' ? f.text.value.trim() : '';
    if (!raw) continue;
    const signal = fieldSignal(f, wantKey);
    if (signal !== null) {
      matched.push({ signal, value: cleanUsername(raw), key: typeof f.key === 'string' ? f.key : '' });
    }
  }
  if (!matched.length) return { username: null, key: null, via: null, ambiguous: false, candidates: [] };

  const best = Math.min(...matched.map((m) => m.signal));
  const tied = matched.filter((m) => m.signal === best);
  const candidates = tied.map((m) => m.key).sort();
  const answer = (m, via) => ({ username: m.value, key: m.key, via, ambiguous: false, candidates });
  // One match on the strongest signal present is the answer, whatever was typed
  // into it. A value that fails validation is a REPORTABLE fact, that the buyer
  // typed something nobody could ever be invited as, and downgrading it to "no
  // field" would hide an order that needs a human today.
  if (tied.length === 1) return answer(tied[0], FIELD_SIGNALS[best]);
  // Several fields matched equally well, so the key has stopped telling them
  // apart and the VALUE gets the casting vote: a GitHub username has a narrow
  // shape, and a field holding something that could not be one is not the field
  // being looked for. Exactly one survivor is an answer. None, or more than one,
  // is a checkout nobody can read, and saying so beats a coin flip.
  const shaped = tied.filter((m) => validUsername(m.value));
  if (shaped.length === 1) return answer(shaped[0], `${FIELD_SIGNALS[best]}, then the shape of the value`);
  return { username: null, key: null, via: FIELD_SIGNALS[best], ambiguous: true, candidates };
}

function extractGithubUsername(session, fieldKey = CANONICAL_FIELD_KEY) {
  return resolveBuyerField(session, fieldKey).username;
}

// Why this order could not be delivered, in the operator's words. Three
// different situations with three different fixes, all of which used to print
// as `invalid github username: null`.
function buyerFieldProblem(resolved) {
  if (resolved.ambiguous) {
    return `this checkout carries more than one field that could be the GitHub username (${resolved.candidates.map((k) => JSON.stringify(k)).join(', ')}), so nobody was invited rather than guessing which one the buyer answered. Leave exactly one of them on the payment link`;
  }
  if (resolved.username === null) {
    return 'this checkout carries no field that reads as a GitHub username, so there is nobody to invite. Add a required text field to the payment link labelled "GitHub username (for repo access)"';
  }
  return `invalid github username: ${JSON.stringify(resolved.username)}`;
}

// GitHub caps a repository at 50 invitations per 24 hours. From the REST docs
// for "Add a repository collaborator" (PUT /repos/{owner}/{repo}/collaborators/
// {username}): "You are limited to sending 50 invitations to a repository per
// 24 hour period. Note there is no limit if you are inviting organization
// members to an organization repository."
//
// WHICH HTTP STATUS CARRIES THAT VERDICT IS NOT DOCUMENTED, and that is the
// whole problem. The same page documents 403 ("Forbidden") and 422
// ("Validation failed, or the endpoint has been spammed") without saying which
// one the cap uses; the general rate-limit page says primary and secondary
// limits return "403 or 429". The github/docs issue asking for exactly this
// clarification (#18506) is open and unresolved, and its reporter could not
// even trigger the cap to find out. We cannot generate 50 real invitations to
// settle it either.
//
// So this is deliberately NOT keyed on status. The cap is a per-repository
// endpoint quota, not the core 5000/hour quota, so x-ratelimit-remaining still
// reads healthy while it is in force and the header path cannot see it. The
// one signal GitHub does emit consistently is the sentence itself, so that is
// what we match, across every status it could arrive with.
const INVITE_CAP_PER_REPO_PER_DAY = 50;
const INVITE_CAP_RE = /\blimited to (?:sending|creating) \d+ (?:organization )?invitations?\b/i;

// Matched against GitHub's RESPONSE BODY only, never against a message we
// built. Decorating a message and then pattern-matching it is how the old
// prose check started matching our own hint text: inviteStatusHint(403) ends
// with "or a secondary rate limit is in force", so /secondary/ matched EVERY
// permissions 403 and retried a dead token for six hours.
function isInvitationCapError(err) {
  return !!err && INVITE_CAP_RE.test(String(err.body ?? ''));
}

// How long GitHub itself says to wait, in ms, or null if it said nothing.
// Documented order of precedence (REST "rate limits" / "best practices"):
//   1. `retry-after: <seconds>` — what a SECONDARY limit sends. Short, and the
//      one a burst actually trips.
//   2. `x-ratelimit-remaining: 0` + `x-ratelimit-reset: <unix>` — a PRIMARY
//      limit. Waits until the top of the hour window, i.e. potentially ~1h.
// The two behave differently and that difference is the whole reason to read
// headers instead of guessing: a secondary limit is worth waiting out inside
// the run, a primary one never is.
function retryAfterMs(headers, now = Date.now()) {
  if (!headers) return null;
  const get = (k) => {
    const v = typeof headers.get === 'function' ? headers.get(k) : headers[k];
    return v == null ? null : String(v).trim();
  };
  const ra = get('retry-after');
  if (ra && /^\d+$/.test(ra)) return Number(ra) * 1000;
  const remaining = get('x-ratelimit-remaining');
  const reset = get('x-ratelimit-reset');
  if (remaining !== null && /^\d+$/.test(remaining) && Number(remaining) === 0 && reset && /^\d+$/.test(reset)) {
    return Math.max(0, Number(reset) * 1000 - now);
  }
  return null;
}

// Invite failures split two ways. Transient (no HTTP verdict at all, 429,
// 5xx, or a rate-limited 403): worth retrying on the next poll, so the
// session is NOT marked processed. Everything else (no such user, bad
// token) is a permanent needs_attention row for a human.
function isTransientInviteError(err) {
  if (!err || err.permanent) return false;
  // The cap clears on its own, so it is transient whatever status it wore.
  // Checked before the status rules because it arrives as a 403 or a 422 and
  // the 422 branch below would otherwise file it as permanent on attempt one.
  if (isInvitationCapError(err)) return true;
  if (err.status == null) return true; // fetch threw: DNS, timeout, reset
  if (err.status === 429 || err.status >= 500) return true;
  if (err.status !== 403) return false;
  // A 403 is transient ONLY when it is a rate limit — otherwise it is a token
  // that lacks admin, which retrying cannot fix. GitHub signals a limit in the
  // headers as well as the prose; matching prose alone (the old test) misses a
  // limit worded any other way, and the wording is not part of any contract.
  // Headers first, then GitHub's own words. Read err.body, never err.message:
  // the message carries our hint text, which itself says "secondary rate
  // limit", so matching it classified every permissions 403 as retryable.
  return retryAfterMs(err.headers) !== null || /rate limit|secondary/i.test(String(err.body ?? ''));
}

// --- in-run retry -----------------------------------------------------------
// A transient invite failure used to cost the buyer a WHOLE POLL INTERVAL,
// because the only retry was "next poll". Once the poll became hourly
// reconciliation rather than the delivery path, that worst case became ~60
// min for a failure that typically clears in seconds — and the failure it
// covers, a secondary rate limit, is exactly what a launch-day burst trips.
//
// So retry inside the run that is already running. The run costs a whole
// billed Actions minute regardless of whether it spends 13s or 60s (jobs bill
// rounded up), so a bounded wait here is close to free, while the alternative
// is an hour of a paying buyer staring at nothing.
//
// Bounded three ways so this can never become the thing that hangs delivery:
//   - RUN budget, shared across every session in the run, so ten failing
//     buyers cannot serialize into ten separate waits.
//   - a per-wait ceiling, so a PRIMARY limit's "come back in 50 minutes" is
//     declined rather than slept through.
//   - attempts, so a server erroring instantly in a loop still terminates.
// Anything the budget declines falls through to the existing behaviour
// unchanged: not marked processed, retried by the next poll.
const IN_RUN_RETRY_BUDGET_MS = 60_000;
const IN_RUN_MAX_WAIT_MS = 30_000;
const IN_RUN_MAX_ATTEMPTS = 3;

// Backoff for a transient with no header to go on (timeout, reset, 5xx).
const IN_RUN_BACKOFF_MS = [1_000, 4_000];

// How long to wait before retrying this invite inside the run, or null for
// "don't — let the poll have it". `spentMs` is the run's cumulative wait so far.
function inRunRetryDelayMs(err, attempt, spentMs, now = Date.now()) {
  if (!isTransientInviteError(err)) return null;
  // Never retry the cap inside the run. It clears in hours, so every attempt
  // is guaranteed to fail, and GitHub's rate-limit guidance is explicit that
  // continuing to call while limited "may result in the banning of your
  // integration". The poll picks it up once the window has actually moved.
  if (isInvitationCapError(err)) return null;
  if (attempt >= IN_RUN_MAX_ATTEMPTS) return null;
  const left = IN_RUN_RETRY_BUDGET_MS - spentMs;
  if (left <= 0) return null;
  const stated = retryAfterMs(err.headers, now);
  // GitHub said how long: honour it exactly, or decline if it is too long to
  // be worth holding the run open. Never wait less than it asked — that is
  // how a secondary limit gets extended.
  const wait = stated === null ? IN_RUN_BACKOFF_MS[Math.min(attempt - 1, IN_RUN_BACKOFF_MS.length - 1)] : stated;
  if (wait > IN_RUN_MAX_WAIT_MS || wait > left) return null;
  return Math.max(0, wait);
}

// The retry budget is TIME, not attempts: an attempt cap burns out in
// minutes on a fast poll cadence, which a routine GitHub incident
// outlasts. Retries run for 6h from the FIRST transient failure (the
// "always within a few hours" delivery promise), then surface to a human.
const INVITE_RETRY_WINDOW_SECONDS = 6 * 3600;

// The cap is the one failure whose clearing time we KNOW, and it is longer
// than the general window, so it gets its own. Widening the general window to
// cover it would be the wrong trade: 6h is how long a genuinely broken order
// waits before a human is told, and stretching that to a day to accommodate a
// condition that resolves itself would make every unrelated breakage quieter.
//
// 26h = GitHub's 24h period + 2h slack. The cap is a rolling 24h window per
// repo, so the longest a blocked invite can wait is just under 24h from the
// moment it is blocked (the oldest of the 50 ages out). The 2h covers the poll
// cadence, clock skew between us and GitHub, and the gap between the true
// start of the block and our first blocked attempt. Under 24h and a launch-day
// queue expires before GitHub relents, which is the bug this fixes; far over
// 26h and a cap that is really something else sits unreported for no reason.
//
// The escalation delay this buys is NOT silence: a capped repo is announced on
// the run that detects it (see fulfill.js), so the operator knows within one
// poll. The window governs when we stop trying, not when we speak up.
const INVITE_CAP_RETRY_WINDOW_SECONDS = 26 * 3600;

function inviteRetryWindowSeconds(err) {
  return isInvitationCapError(err) ? INVITE_CAP_RETRY_WINDOW_SECONDS : INVITE_RETRY_WINDOW_SECONDS;
}

function shouldRetryInvite(err, failures, sessionId, now = Date.now()) {
  if (!isTransientInviteError(err)) return false;
  const first = failures.find((f) => f.session === sessionId && f.transient);
  return !first || now - Date.parse(first.ts) < inviteRetryWindowSeconds(err) * 1000;
}

function inviteAttempts(failures, sessionId) {
  return failures.filter((f) => f.session === sessionId && f.transient).length;
}

// state.failures was the only array in the state file with no ceiling, while
// processed and unmatched both have one. It is appended to on every failed
// attempt and the whole file is committed to git every cycle, so a sustained
// GitHub incident grows it without bound.
//
// It cannot be trimmed by age alone. shouldRetryInvite dates the 6h retry
// window from a session's FIRST transient row, so dropping that row silently
// restarts the budget and the session retries forever instead of surfacing to
// a human. The safe cut is by SETTLEMENT: a row whose session is already in
// processed is never consulted again (shouldRetryInvite only runs for sessions
// that are not processed), so those are the droppable ones — oldest first,
// original order preserved.
function pruneFailures(failures, processedIds, cap = 2000) {
  const rows = Array.isArray(failures) ? failures : [];
  if (rows.length <= cap) return rows;
  const settled = new Set(processedIds);
  const droppable = rows.reduce((n, f) => n + (settled.has(f.session) ? 1 : 0), 0);
  const keep = rows.length - droppable;
  let toDrop = Math.min(droppable, Math.max(0, rows.length - Math.max(cap, keep)));
  if (toDrop <= 0) return rows;
  return rows.filter((f) => {
    if (toDrop > 0 && settled.has(f.session)) { toDrop--; return false; }
    return true;
  });
}

function isPaidComplete(session) {
  // "no_payment_required" covers fully-discounted (100% promo) checkouts.
  return (
    session.status === 'complete' &&
    (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')
  );
}

// Match a session to a fulfillment grant by payment link id, or by price id
// (covers server-created Checkout Sessions, which have no payment_link —
// requires the session list to expand data.line_items).
function sessionPrices(session) {
  const items = (session.line_items && session.line_items.data) || [];
  return items.map((li) => li.price && li.price.id).filter(Boolean);
}

function matchGrant(session, grants) {
  const byLink = session.payment_link
    ? grants.find((g) => g.payment_link && g.payment_link === session.payment_link)
    : null;
  if (byLink) return byLink;
  const prices = sessionPrices(session);
  return grants.find((g) => g.price && prices.includes(g.price)) || null;
}

function pickNewPaidSessions(sessions, processedIds, grants) {
  const seen = new Set(processedIds);
  return sessions.filter(
    (s) => isPaidComplete(s) && !seen.has(s.id) && matchGrant(s, grants) !== null
  );
}

// The one failure the engine used to swallow whole: a session the buyer PAID
// for that matches no grant. pickNewPaidSessions drops it, so the run prints
// "new_paid=0", exits 0, and looks perfectly healthy while the money sits in
// the account and the buyer waits for access that is never coming. grantProblems
// catches a grant that is malformed; this catches a grant that is merely wrong
// (right shape, wrong id) or absent. Warn once per session — the caller
// remembers which ids it has already reported, so a permanently unmatchable
// session doesn't re-alert on every poll forever.
function unmatchedPaidSessions(sessions, warnedIds, grants) {
  const seen = new Set(warnedIds);
  return sessions.filter(
    (s) => isPaidComplete(s) && !seen.has(s.id) && matchGrant(s, grants) === null
  );
}

// How long a completed-but-unfunded checkout stays worth waiting for.
//
// Delayed-notification payment methods do not settle at checkout. SEPA Direct
// Debit, ACH debits, Bacs and boleto all complete the session immediately with
// payment_status "unpaid" and only flip to "paid" once the funds actually
// arrive, which for ACH and SEPA is commonly several business days. Stripe's
// own ceiling for these is measured in days, not hours, so 14 days is chosen to
// sit past every one of them plus a bank holiday weekend.
//
// It is a ceiling, not a schedule: nearly all settle far sooner, and the cost
// of the window is only that the cursor stops advancing while one is in flight.
// Re-scanning is free (the processed-id set dedups); a missed sale is not.
const ASYNC_SETTLE_SECONDS = 14 * 24 * 3600;

// Checkouts that completed but whose money has not landed yet.
//
// This is the third state, and the engine used to have no name for it. A card
// session is complete-and-paid, an abandoned one is open-and-unpaid, but a SEPA
// or ACH session sits complete-and-unpaid for days. isPaidComplete rightly
// refuses to deliver it, so it is never marked processed — and nothing else
// held it either, so the cursor advanced past its `created` time and 25h later
// the scan query (created > cursor - OVERLAP) stopped returning it. When the
// funds finally arrived there was no poll left that could see the session.
// The buyer paid, the money was in the account, and access was never granted,
// with nothing in the log to say so: the session simply stopped existing.
//
// So these are handed to the caller to defer, which holds the cursor and keeps
// them inside the scan window until they flip to paid and fulfill normally.
//
// The hold is bounded on purpose. A direct debit that is never going to arrive
// must not freeze the cursor for the life of the store, so past the settle
// window it stops being held. That is the one honest trade here: after 14 days
// the row is stale and visible to an operator rather than pinning the poll.
//
// `status === 'complete'` is what separates this from an abandoned cart. An
// open session is unpaid because nobody finished paying, and holding the cursor
// for every abandoned checkout would freeze it permanently.
function asyncPendingSessions(sessions, processedIds, grants, now = Math.floor(Date.now() / 1000)) {
  const seen = new Set(processedIds);
  return sessions.filter(
    (s) =>
      s.status === 'complete' &&
      s.payment_status === 'unpaid' &&
      !seen.has(s.id) &&
      matchGrant(s, grants) !== null &&
      Number.isFinite(s.created) &&
      now - s.created <= ASYNC_SETTLE_SECONDS
  );
}

// Public-safe ledger row: no names, no emails, no session ids in the clear.
function ledgerRow(session, grant) {
  return {
    ts: new Date(session.created * 1000).toISOString(),
    product: grant.product,
    amount: (session.amount_total ?? 0) / 100,
    currency: (session.currency || '').toUpperCase(),
    country:
      (session.customer_details &&
        session.customer_details.address &&
        session.customer_details.address.country) ||
      null,
    ref: crypto.createHash('sha256').update(session.id).digest('hex').slice(0, 10),
  };
}

// Advance the poll cursor to the newest session seen, never backwards.
//
// `deferredCreated`: created-times of sessions this run saw and deliberately
// did NOT settle (a transient invite failure, or a repo at the invitation
// cap). Those sessions are only ever retried or escalated by a later poll
// SEEING them again, and the scan window is created > cursor - OVERLAP, so a
// cursor that advances past created + OVERLAP drops them from every future
// scan: no retry, no escalation, no needs_attention row. A launch that queues
// buyers behind the invitation cap for more than the overlap window used to
// lose every one of them exactly this way, silently. So the cursor never
// advances past the point that would push a deferred session out of the
// window. The hold is bounded: retries stop at the retry window (6h, 26h for
// the cap), the poll after that escalates and settles the session, and the
// cursor is free again.
function nextCursor(sessions, prevCursor, deferredCreated = []) {
  const newest = sessions.reduce((acc, s) => Math.max(acc, s.created || 0), 0);
  let next = Math.max(prevCursor || 0, newest);
  for (const created of deferredCreated) {
    // Strictly newer than cursor - OVERLAP stays visible, so created +
    // OVERLAP - 1 is the last cursor value that still scans this session.
    if (Number.isFinite(created)) next = Math.min(next, created + OVERLAP_SECONDS - 1);
  }
  // Never backwards, even under hold: freezing at prevCursor keeps the scan
  // window fixed, which keeps every session currently visible visible.
  return Math.max(prevCursor || 0, next);
}

// A grant matches a session by payment link ID (plink_...) or price ID
// (price_...), never by the buyer-facing checkout URL. Pasting the URL is an
// easy mistake and the worst kind: the grant simply never matches, so every
// paid order is skipped with a green run and exit 0. Surface it on every poll
// instead of losing sales quietly. Warnings, not a hard exit: one bad grant
// must not stop a working product from delivering.
function grantProblems(grants) {
  const out = [];
  (Array.isArray(grants) ? grants : []).forEach((g, i) => {
    const where = `fulfillment[${i}]${g && g.product ? ` ("${g.product}")` : ''}`;
    if (!g || typeof g !== 'object') { out.push(`${where} is not an object`); return; }
    const link = typeof g.payment_link === 'string' ? g.payment_link : '';
    const price = typeof g.price === 'string' ? g.price : '';
    if (/^https?:\/\//i.test(link)) {
      out.push(`${where} payment_link is a checkout URL, which never matches a session; use the link's id (plink_...) from the Stripe dashboard`);
    } else if (link && !link.startsWith('plink_')) {
      out.push(`${where} payment_link "${link}" is not a plink_ id`);
    }
    if (price && !price.startsWith('price_')) out.push(`${where} price "${price}" is not a price_ id`);
    const matchable = link.startsWith('plink_') || price.startsWith('price_');
    if (!matchable) out.push(`${where} can never match a sale: set payment_link (plink_...) or price (price_...)`);
    if (!g.repo) out.push(`${where} has no "repo": a matched sale would have nowhere to invite the buyer`);
  });
  return out;
}

// A zero-cost fulfillment is a real invite that moved no money: a 100% coupon,
// a fully-discounted session, or a mispriced grant. It must never read like a
// normal sale in the log. The failure this guards against is a discount code
// working in front of an audience while the run reports it exactly like a paid
// order — the ledger row says amount 0, but nobody reads the ledger mid-launch.
function isFreeFulfillment(session) {
  return (
    (session.amount_total ?? 0) === 0 ||
    session.payment_status === 'no_payment_required'
  );
}

// A buyer who owns the target repo already has access (sellers test-buying
// their own product) — treat as fulfilled without an invite.
function isRepoOwner(repo, username) {
  const owner = String(repo).split('/')[0];
  return !!username && owner.toLowerCase() === String(username).toLowerCase();
}

// What a GitHub invite status MEANS, in the operator's words. Anything not
// listed is unrecognized, and unrecognized must never read like success: the
// engine treats it as an outright failure and says so in the log line.
const INVITE_STATUS_HINT = {
  404: 'no such GitHub user, check for a typo in the checkout field',
  403: 'forbidden — the token lacks admin on this repo, org policy blocks the invite, or a secondary rate limit is in force',
  422: 'GitHub rejected the invite as invalid (the account cannot be added to this repo)',
  401: 'the fulfillment token is bad or expired — NOTHING is being delivered until it is replaced',
};

// `body` is GitHub's raw response. The cap outranks the status table: it
// arrives as a 403 or a 422, and both of those entries would otherwise send
// the operator hunting for a token problem or a bad buyer account when the
// real answer is "this repo is full for today and will drain by itself".
function inviteStatusHint(status, body = '') {
  if (isInvitationCapError({ body })) {
    return ` (GitHub's cap of ${INVITE_CAP_PER_REPO_PER_DAY} repository invitations per 24 hours is in force:` +
      ` the buyer is queued and will be invited automatically, nothing is lost)`;
  }
  if (INVITE_STATUS_HINT[status]) return ` (${INVITE_STATUS_HINT[status]})`;
  if (status >= 500) return ' (GitHub server error — transient, will retry)';
  if (status === 429) return ' (rate limited — transient, will retry)';
  return ' (UNRECOGNIZED status — treated as NOT delivered)';
}

module.exports = {
  OVERLAP_SECONDS,
  ASYNC_SETTLE_SECONDS,
  asyncPendingSessions,
  REQUEST_TIMEOUT_MS,
  stripeMode,
  redactKeys,
  INVITE_STATUS_HINT,
  inviteStatusHint,
  INVITE_RETRY_WINDOW_SECONDS,
  INVITE_CAP_RETRY_WINDOW_SECONDS,
  INVITE_CAP_PER_REPO_PER_DAY,
  isInvitationCapError,
  inviteRetryWindowSeconds,
  IN_RUN_RETRY_BUDGET_MS,
  IN_RUN_MAX_WAIT_MS,
  IN_RUN_MAX_ATTEMPTS,
  retryAfterMs,
  inRunRetryDelayMs,
  isTransientInviteError,
  shouldRetryInvite,
  inviteAttempts,
  pruneFailures,
  isRepoOwner,
  isFreeFulfillment,
  grantProblems,
  validUsername,
  CANONICAL_FIELD_KEY,
  resolveBuyerField,
  extractGithubUsername,
  buyerFieldProblem,
  isPaidComplete,
  matchGrant,
  pickNewPaidSessions,
  unmatchedPaidSessions,
  ledgerRow,
  nextCursor,
};
