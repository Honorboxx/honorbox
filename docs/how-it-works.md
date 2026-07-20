# How HonorBox works (and its limits)

## Architecture

Three repos, no servers:

| Repo | Visibility | Holds |
|---|---|---|
| storefront | public | static site source, built to GitHub Pages |
| product | private | what buyers get; buyers invited read-only |
| ops | private | fulfillment workflow, Stripe key, state, ledger source |

**No server.** Out of the box, fulfillment is a poll: a scheduled Action lists Stripe Checkout
Sessions created since the last cursor (with a 25-hour overlap window, wider
than Stripe's 24-hour default session expiry so a checkout completed a day
after it was opened is never missed) and
processes the ones that are `complete` and paid. Idempotency comes from a
committed set of processed session ids, so re-runs and overlaps are safe.

**Why the default is a poll:** a webhook needs an endpoint that is always
reachable: TLS, retries, signature verification, and one more place for a
secret to live. A poll from CI needs none of that, needs no account beyond
Stripe and GitHub, and is at most ~15 minutes behind, which is survivable for
"invite to a repo" delivery.

That is a floor, not a ceiling. If minutes are too slow, [webhook
mode](instant-delivery.md) delivers in seconds on a free serverless tier, and
the poll stays on underneath it as the safety net. The engine is the same
either way, so turning it on later changes nothing about how sales are
processed.

## Delivery model

The only delivery channel is a **GitHub collaborator invite** to the private
product repo. That's deliberate:

- It's access-controlled: no "secret download URL" that leaks.
- It's durable: buyers keep access and get updates via `git pull`.
- It's auditable: the invite log is the entitlement record.

**Sending the invite is not the same as delivering it.** The buyer has access
only once they *accept*, and GitHub expires an unaccepted invitation seven days
after it was created. Until they accept, every system you own reads "delivered":
Stripe says paid, the ledger has a row, the run is green. If they never open the
email, that stays true right up to the moment the invitation lapses, and then
they have nothing permanently, with nothing anywhere saying so.

**The engine fixes this for you.** Re-issuing an invitation restarts the
seven-day clock, so `scripts/renew-invites.js` re-issues one at six days, a full
day before it would lapse. It runs as a step in the fulfillment workflow, on the
same poll and at no extra cost in Actions minutes
([setup.md § 7](setup.md#7-what-this-costs)). The buyer gets a fresh invitation
email and the door stays open.

It is not an infinite mail loop. Three renewals is the limit, so a buyer gets
four contacts in total across about 24 days, and then the run says so on
stderr:

```
WARN: giving up on re-inviting octocat to you/product after 3 renewals
(created 2026-06-26T09:14:02Z): they paid, have never accepted, and this
invitation will now be allowed to expire; email them or refund them
```

That line is the point. The failure this replaces was silent; somebody who
ignores four emails over three weeks needs a human, and now you are told which
buyer and when instead of finding out never.

Three things are still worth doing yourself:

- Put "accept the invite" in your post-payment confirmation and receipt. Most
  buyers who miss it simply did not realise there was a second step, and a
  renewal three weeks later is a poor substitute for them reading the first one.
- If you refund somebody, run `node scripts/renew-invites.js --revoke
  you/product:theirusername`. That removes their access, deletes any pending
  invitation, and records the revocation permanently so renewal can never hand
  it back. Removing them by hand on GitHub does *not* record anything, and a
  poll already in flight can re-invite them.
- Renew from one place only. If you also run some other tool that re-issues
  invitations for the same product repos, both will send, and your buyer gets
  two of every email. Pick a single owner for renewal per repo.

Pro's [ops bots](https://github.com/Honorboxx/honorbox-pro) add the reporting
around this: continuous triage of every pending invitation rather than a warning
only when renewal gives up, revocation driven automatically off Stripe refunds
instead of a command you remember to run, and a reconciler that pairs
invitations back to the money.

Note what "durable" costs you if you sell a subscription: removing a collaborator
stops future `git pull`, but the clone they already have stays on their machine.
A subscription here sells continued access and future updates, not use of the
product. See [selling a subscription](subscriptions.md).

The cost: by default delivery is not instant (the poll runs on a schedule and
GitHub sometimes delays it). Set that expectation at checkout:
"usually within minutes, always within a few hours." If you want near-instant
delivery, opt into [webhook mode](instant-delivery.md): a signed Stripe webhook
hits a tiny serverless relay you supply (free tier) which fires a GitHub
`repository_dispatch`, and fulfillment runs in seconds. Polling stays the
zero-infra default; webhook mode is the upgrade for when minutes aren't fast
enough.

## GitHub's invitation cap: 50 per repo per day

This is the one ceiling on how fast a store can sell, and it is GitHub's, not
HonorBox's. From the REST docs for
[adding a repository collaborator](https://docs.github.com/en/rest/collaborators/collaborators#add-a-repository-collaborator):

> You are limited to sending 50 invitations to a repository per 24 hour
> period. Note there is no limit if you are inviting organization members to
> an organization repository.

So a personal-account product repo delivers at most **50 new buyers in any
24 hours**. Sale 51 on a good day is refused by GitHub until the window frees
a slot. Buyers who already have access are unaffected: the cap counts
invitations, not pulls.

**What the engine does about it.** Nothing is lost and nothing needs doing:

- The refusal is recognized as the cap rather than as a broken order, and the
  buyer stays in the retry queue instead of being written off. Retries run for
  26 hours, which outlasts GitHub's own 24-hour window, so a queued buyer is
  delivered as soon as a slot frees.
- Once a repo reports the cap, the run stops inviting to that repo for the
  rest of that cycle. Sixty sales in an hour deliver fifty and queue ten,
  rather than making ten more calls GitHub has asked us not to make.
- You are told on the run that sees it, not by the buyer:

```
WARN: you/product has reached GitHub's cap of 50 repository invitations per
24 hours. Sales are still being recorded and NOTHING is lost: queued buyers
are invited automatically as the cap frees up, which takes up to 24h from the
invite that filled it. This ceiling cannot be removed: inviting buyers as org
members is capped too (50/day for a new org, 500 once it is over a month old)
and it lets every buyer list every other buyer.

WARN: 10 paid buyers are waiting behind the invitation cap on you/product.
```

**There is no way to remove this ceiling, so plan around it rather than
against it.** GitHub's note that inviting organization members to an
organization repository is uncapped applies to people who are *already* members.
A buyer who just paid is not, so creating that membership is itself capped: 50
new organization invitations per 24 hours, rising to 500 once the organization
is over a month old or on a paid plan. That moves the ceiling from per repo to
per organization, which is worse if you sell several products from one
organization, and worse again during your first month.

Inviting buyers as organization members also lets every buyer list every other
buyer, because GitHub returns concealed members to anyone inside the
organization. Your customer list becomes readable by your customers. HonorBox
invites buyers as outside collaborators for that reason and will keep doing so.

What the cap actually costs you is a delay, not a sale. Buyers past the fiftieth
are queued and invited automatically as it frees up, and you are told they are
waiting.

One honest caveat: GitHub documents that the cap exists but does not document
which HTTP status it returns, and we cannot manufacture 50 real invitations to
find out. The engine therefore recognises the cap by GitHub's own message
across every status it could plausibly arrive with, rather than betting on one.

## Buyer-input safety

The GitHub username is buyer-supplied text from a Stripe custom field. Before it
touches any API call it must match `^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$` (no
doubled hyphens). Invalid input never reaches a URL; the order is flagged
`needs_attention` in the ledger and a human fixes it from
the Stripe dashboard. Usernames are never interpolated into workflow YAML.

## The ledger

Every fulfillment appends to `ledger/ledger.json` in your **private** ops repo:
date, product, amount, currency, buyer country, and a 10-char SHA-256 prefix of
the session id. No names, emails, or usernames. It's your bookkeeping.

Publishing it is **opt-in**: copy the file into your storefront repo and the
builder renders a public `/trust` page. Some sellers like the radical
transparency; keeping it private is the default.

## Security posture

- Stripe key lives only in the private ops repo's Actions secrets. Use a
  **restricted key** (Checkout Sessions: Read); fulfillment never needs to
  move money.
- The PAT is fine-grained: admin only on the product repo(s).
- Secret-bearing workflows run on `schedule`/`workflow_dispatch` only: no
  `pull_request` surface, no third-party actions in those jobs.
- Public repo workflows (Pages deploy) carry no secrets beyond the default
  scoped token.

## Failure modes

| Failure | What happens |
|---|---|
| Buyer typos username | Order flagged `needs_attention`; fix by hand from Stripe dashboard (buyer email is there); refund if unreachable |
| Buyer never accepts the invite | Renewed automatically at 6 days, up to 3 times. After that the run warns with the buyer's name and stops; email them or refund. See [Delivery model](#delivery-model) |
| GitHub cron delayed | Delivery late by minutes to hours; confirmation message sets expectation |
| Actions outage | Sales queue up; next run drains the backlog (poll + idempotency) |
| More than 50 sales to one repo in 24h | GitHub's [invitation cap](#githubs-invitation-cap-50-per-repo-per-day). Buyers past the 50th are queued and delivered automatically as the window frees, and the run warns with the number waiting. This ceiling cannot be removed; org membership is capped too |
| Stripe key leaked | Restricted key limits blast radius to reading checkout sessions; rotate in dashboard |
| Refund issued | `renew-invites.js --revoke you/product:username` removes access and records it, so renewal can never re-invite them. Removing them by hand on GitHub records nothing |
| Subscription ends | Nothing, unless you turn on [subscription enforcement](subscriptions.md); then the customer is removed after a grace period |
| Subscriber's card fails | Nothing. `past_due` is never treated as a cancellation while Stripe is still retrying |
