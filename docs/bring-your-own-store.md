# Bring your own store: what Pro runs, and what skips

You made your payment links in the Stripe dashboard. You deliver by inviting the
buyer to a private repo, with glue you wrote or by hand. Before spending $29 the
question is not whether the suite is any good. It is whether any of it runs on
what you already have, or whether it assumes the engine this repo ships and
quietly does nothing without it.

This page answers that before you pay. The config Pro reads, the one change to
your checkout, which modules run in full, which ones step aside and what they
print when they do, the limits, and the key scopes you need on your own account.
Every claim below is traced to a file in the Pro repo, and every transcript is
what those modules print, on a store that does not exist.

Pro ships its own quickstart for the day after you buy. This one is for the day
before, so the parts that skip are listed by name rather than left for you to
discover.

## What Pro reads

Nothing in the suite builds pages and nothing in it needs them. The modules that
guard money read three things: your Stripe account, your product repos on
GitHub, and one JSON file naming which payment link grants which repo.

That file and one checkout field are the whole adoption cost. The shape, from
`examples/store.config.minimal.json` in the Pro repo, with placeholder values
throughout:

```json
{
  "name": "Acme Tools",
  "seller": "Sold by Jane Doe (sole trader, NL), merchant of record",
  "support_email": "support@example.com",
  "fulfillment": [
    { "payment_link": "plink_XXXXXXXXXXXXXXXXXXXXXX", "product": "Alpha CLI", "repo": "acme/alpha-cli-access" }
  ]
}
```

One row per product: the payment link that sells it, and the private repo the
buyer gets invited to. `payment_link` is the **id**, the `plink_` string from the
dashboard or from `GET /v1/payment_links`, not the buyer-facing URL. Everyone
pastes the URL once, so both the doctor and the audit check for that mistake by
name.

If you also create Checkout Sessions through the API, or sell through coupon
codes, add the price id to the same row (`"price": "price_XXXXXXXXXXXXXXXXXXXX"`).
A server-created session carries no payment link at all and matches by price or
not at all (`reconcile/lib/reconcile-core.js`, `matchGrant`).

Note what is absent: no theme, no site URL, no `products/` directory. That
absence is the signal. A config with no theme and no products directory is read
as a store that brings its own storefront, and the engine-layout checks step
aside for it with their reason printed rather than passing silently
(`doctor/doctor.js`). Keep the file in a private repo. It holds nothing secret,
and there is still no reason to publish your product mapping.

## The one change to your checkout

Every module here ties a payment to a buyer through one fact: the GitHub
username asked for at checkout. If your links already collect it, you are done,
and the rest of this section is reference.

What to add is a **required text field**, labelled

> **GitHub username (for repo access)**

Copy that label. Custom fields also carry a `key`, which is what an integration
would normally match on, and on a link built in the dashboard the key is not
yours: Stripe's API requires every custom field to have one, and the dashboard
neither asks for a key nor shows you the one it stores. So the modules identify
the field three ways, in order. The key `github_username` where you set it over
the API. The same key through differences of case and punctuation. Otherwise the
label, which is the only thing a dashboard-made field gives you to go on.

Keep to one such field per link. Where two could each be the username, an order
is resolved by the shape of what the buyer typed if that separates them, and
stopped with both field keys named if it does not, because an invitation to a
private repo cannot be taken back and a wrong one is worse than a late one.

### Adding it to a link you already sell through

**The dashboard cannot do this.** On a payment link that already exists, Edit is
unavailable, so there is no clicking route to add a field to it. One API call
does, and **the link URL is unchanged**, so nothing you have published goes
stale and no buyer sees a difference:

```bash
curl https://api.stripe.com/v1/payment_links/plink_XXXXXXXXXXXXXXXXXXXXXX \
  -u "$STRIPE_SECRET_KEY:" \
  -d "custom_fields[0][key]=github_username" \
  -d "custom_fields[0][type]=text" \
  -d "custom_fields[0][label][type]=custom" \
  -d "custom_fields[0][label][custom]=GitHub username (for repo access)"
```

Send every field the link should end up with, not only the new one: read what is
already there with `GET /v1/payment_links/<id>` first.

That call is a write, and it is the only write anywhere in this document. It
needs a key with write access to Payment Links, which is not one of the scopes
in the table further down, because no module here ever writes to Stripe. Do it
once, then go back to the read-only key the tools run on.

### Or start a new link

Then the dashboard route works: Options, Add custom fields, Text, type the
label, mark it required. It will not ask you for a key. What a new link does
give you is a **new URL**, so anything already pointing at the old one has to be
updated, which is the reason the API call above is the better move for a link
already in use.

### Knowing it worked, before a buyer tests it for you

The doctor reads your links and says, per link, whether anything here could find
a buyer on them and what it matched on:

```
[ OK ] stripe: plink_XXXXXXXXXXXXXXXXXXXXXX collects a GitHub username (matched on its label)
```

A link that collects nothing it can read is a `[FAIL]` with the fix attached,
not a silent pass, and the audit makes the same judgement standing, across every
active link in the account rather than only the ones your config names. That
pairing is deliberate: a link nobody can deliver against is the one setup
mistake that stays invisible until a stranger has already paid.

### The orders you took before the field existed

They carry no username, so there is nothing to check a repo against. Pro neither
guesses nor goes quiet about them. Each one surfaces as its own line, labelled
`PAID, NO USERNAME`, with the session id to look it up by:

```
HonorBox reconcile: last 90 days

[WARN] 2026-04-02 Alpha CLI     29 USD     (no username)     PAID, NO USERNAME
       this session carries no GitHub username, so there is nothing to check
       the repo against: the checkout predates the custom field, or the
       payment link is missing it. Add the field to the link, then find this
       buyer on the session in Stripe and confirm delivery by hand
       cs_live_XXXXXXXXXXXX0002
[ OK ] 2026-05-14 Alpha CLI     29 USD     @ada-example      delivered
       cs_live_XXXXXXXXXXXX0001

2 paid orders in window · 1 confirmed · 1 need attention · 0 not delivered
revenue actually collected: 58 USD across 2 paid orders

Nothing is lost yet. The WARN rows become losses if nobody chases them.
```

It is a warn and not a loss on purpose. An absent username proves only that the
session cannot be mapped to a GitHub account, and a hand-rolled store may well
have delivered that order by hand long before this tool existed. Calling it lost
would assert something nobody observed, and a first report that shouts LOST at
your entire pre-field history is a report you stop reading
(`reconcile/lib/reconcile-core.js`). Confirm them once from the session in
Stripe, which carries the buyer's email, or bound the window with `--days` to
the day the field went live.

The same absence has one consequence after the sale, and it is the one worth
knowing before you buy: a refund on a pre-field order cannot be tied to a GitHub
account either, so the refund guard revokes nothing and says so loudly, naming
the buyer to remove by hand (`ops-bots/bots.js`). It never records that refund as
handled.

## What runs, and what steps aside

| Module | On a store you built yourself |
|---|---|
| `reconcile/` | Full. Stripe checkout sessions, refunds and disputes crossed against live GitHub collaborator and invitation state. No engine record is read, so there is nothing for it to be missing |
| `stats/` | Full. Reads Stripe only |
| `ops-bots/` | Refund guard and dispute guard full. Issue triage runs only if your config names a public repo you take support issues on, and prints that it is skipping when it does not |
| `doctor/` | Config, live Stripe and GitHub token tiers all run. Storefront checks print `[SKIP]` with the reason and are counted apart from the checks |
| `audit/` | The money-path checks run. The two that read the engine's ledger and fulfillment state print `UNKNOWN` with the reason, and the storefront checks have no pages to read |
| `guard/` | Full. It is the audit and the reconciler on a schedule, alarming through an issue in your own ops repo |
| `license-module/` | Full, and independent of everything else here |
| `playbook/` | Prose. Reads fine with no store at all |
| `themes/` | Engine only. A theme is instructions to the engine's page builder, and you are not using one |

A skipped check is printed by name with its reason and is never counted as a
pass. Both transcripts below are from the same config shown above, with no keys
set, so you can see exactly what a first run looks like.

### The doctor

```
[ OK ] config: parses
[ OK ] config: has name
[SKIP] config: theme - no theme and no products directory: config-only setup, the storefront is yours
[SKIP] config: url - optional without a storefront; set it to your own site to get the reachability check
[ OK ] config: fulfillment[] present
[ OK ] fulfillment[0]: repo is owner/name
[ OK ] fulfillment[0]: payment_link is a plink_ id
[SKIP] products - no products directory: your pages are not the engine's to check
[WARN] stripe: live checks - set STRIPE_SECRET_KEY to verify payment links against the API
[WARN] github: token checks - set GH_FULFILL_TOKEN to verify invite permissions

7 checks, 0 failing, 3 skipped (no engine storefront)
```

The summary counts skips apart from checks, which is what stops three skipped
lines from reading as three passes. Give it the two keys and the WARN lines
become the live tiers: each `plink_` id verified to exist and to be active, each
`price_` id verified to exist, and each product repo verified reachable,
private, and administrable by the token you handed it. Those checks are exactly
as strict for a hand-rolled store as for an engine one, because they are about
your money rather than your markup.

### The audit

```
HonorBox audit: the known ways this architecture loses money quietly

scanned /tmp/acme-ops (0 source files, 0 product pages)
config  /tmp/acme-ops/store.config.json

[UNKNOWN] A paid checkout that matches no fulfillment grant
         shipped defect: real bug, reproduced, no victim (2026-07-20)
         no fulfillment state at /tmp/acme-ops/state/fulfill-state.json:
         unmatched-history check skipped
         -> the engine records paid-but-unmatched sessions in
         state/fulfill-state.json; a store running its own fulfillment never has
         it. Reconcile reports the same orders live as PAID, NO GRANT.
         (not checked: Needs a Stripe key to enumerate your links. Without one,
         only the historical half runs (from local state).)

[  OK  ] The checkout URL pasted where Stripe reports an id
         shipped defect: real bug, reproduced, no victim (2026-07-19)
         1 grant(s) can match a session

[  OK  ] A forked store still selling through the original author's checkout
         shipped defect: real bug, reproduced, no victim (2026-07-19 / 2026-07-20)
         no exact-string URL gates

[UNKNOWN] A poll cadence that outruns the free tier, then stops delivering
         incident: happened here (2026-07-19)
         no scheduled workflows found to cost
         -> if you poll from somewhere this check cannot see (launchd, systemd, an
         external cron), confirm its cadence yourself.
         (not checked: Recognises the cron cadences people actually write; anything
         exotic reports UNKNOWN rather than guessing. Cannot read your real
         remaining balance: that needs a billing-scoped token we deliberately do
         not ask for.)

[  OK  ] One hung request stalling every buyer behind it
         reasoned guard: has NOT happened here (2026-07-20)
         every fetch() on the money path carries a deadline

[  OK  ] An unstaged file halting delivery
         incident: happened here (2026-07-19)
         no unguarded `git pull --rebase` on the ops path

[  OK  ] Production running a copy of the engine you stopped reading
         incident: happened here (2026-07-20)
         no divergent copies of engine modules

[  OK  ] HTTP 204 logged as if it were a fresh invitation
         incident: happened here (2026-07-19)
         invite code tells 201 (invited) apart from 204 (already had access)

[UNKNOWN] A buyer flagged for attention that nothing ever tells
         reasoned guard: has NOT happened here
         no ledger at /tmp/acme-ops/ledger/ledger.json: needs-attention check
         skipped
         -> the engine writes ledger/ledger.json from the first sale; a store
         running its own fulfillment never has one. Reconcile answers the same
         question straight from Stripe and GitHub.
         (not checked: None, but it only sees what your ledger recorded. A failure
         that never reached the ledger is reconcile's job, not this one.)

[  OK  ] A force-push guard that fails open on the short spelling
         shipped defect: real bug, reproduced, no victim (2026-07-20)
         no force-push guard that misses the refspec form

Live checks skipped (--static-only): payment-link coverage, unreadable
checkouts, forked-checkout detection, dead buy buttons, advertised-price
drift, coupon exposure and invitation expiry all need read credentials. An
entry above marked OK was judged on its static half only, and an entry with
no live-checkable half is not listed at all.

10 entries checked: 0 exposed · 0 warn · 3 unchecked · 7 guarded

UNCHECKED is not a pass. Those checks did not run: the reason is printed
with each one.
```

Two of those three `UNKNOWN` lines are the engine-layout skips, and both name
the module that answers the same question from live state instead. The third is
the poll-cost check, which found no scheduled workflow to price in the tree it
scanned. If you poll from launchd, systemd or a cron it cannot see, it says so
and asks you to confirm that cadence yourself, rather than calling a store it
never costed safe.

The read-credential half is where the interesting checks live, and most of them
apply to you unchanged. With a read-only Stripe key the audit enumerates every
active payment link in the account and reports any that maps to no fulfillment
row, which is exactly how a sale gets collected and never delivered. It reads
your coupons and promotion codes and reports a live 100%-off code on a link that
accepts typed codes. With the GitHub token it reads pending invitations and
names the ones aging toward GitHub's seven-day expiry, which is a sale that
becomes a permanent loss without ever appearing anywhere as one.

Three checks in that half read your product pages, and you do not have any. The
dead-button and price-drift checks report `UNKNOWN` with the reason, because
nothing resolved a page to a link; the forked-checkout check prints the count it
compared, which is zero (`audit/lib/audit-core.js`). None of the three claims a
pass it did not earn, and none has an equivalent to run in its place, because
comparing a page to a link needs a page. If your storefront is a site you
maintain elsewhere, the number printed on it against the number the link charges
stays your job.

## The limits, stated plainly

**No ledger means the history checks step aside.** Dedup and delivery history
live in the engine. A store that runs its own fulfillment has neither file, so
the two checks that read them print `UNKNOWN` and name reconcile as the module
that answers the same questions live. That is a real reduction in what the audit
covers, and the transcript above shows it rather than hiding it.

**Pro checks the setup you describe.** The config is a file you write. If you
leave a product out of `fulfillment[]`, no module knows that product exists, and
the one check that would have caught it is the live payment-link sweep, which
needs a Stripe key. Point it at everything you sell, then let the sweep tell you
what you forgot.

**The uncovered-link check assumes payment links sell repo access.** It treats
every active link in the account as one that should map to a fulfillment row,
because a link with no row is precisely how money gets taken and nothing gets
delivered. If your account also sells things that are not repo access, that
check will name them. Its own text says when that is expected, and deactivating
links you no longer sell through clears it.

**The storefront checks have nothing to read.** Covered above. A dead buy button
on a page Pro cannot see is a failure Pro cannot catch.

**The suite is young.** The catalogue behind it is
[published in full and free](failure-catalogue.md), including the gaps that are
still open, so you can judge its coverage before paying rather than after. It
catches what has been catalogued. It cannot see a failure nobody has written
down yet, and where it could not check something it says `UNKNOWN` and why,
never `OK`.

## The keys, on your own account

Same discipline as
[the engine's least-privilege guide](least-privilege.md), which has the exact
dashboard toggles and the blast radius for each key. Nothing in this suite ever
writes to Stripe, so nothing here ever needs Write on anything. In the audit
that is enforced rather than promised: every outbound call goes through one
helper that sends GET and throws on any other method, so a later patch cannot
quietly make it a writer (`audit/lib/readonly.js`).

**Stripe.** Create a
[restricted key](https://docs.stripe.com/keys/restricted-api-keys) (`rk_live_`),
start from zero permissions, and grant **Read** on what the modules you actually
run will call:

| Module | Reads |
|---|---|
| `reconcile/` | Checkout Sessions, Refunds, Disputes |
| `stats/` | Checkout Sessions, Refunds |
| `ops-bots/` | Checkout Sessions, Refunds, Disputes |
| `doctor/` | Payment Links, Prices |
| `audit/` | Payment Links, Coupons, Promotion Codes |

Cut too deep and nothing fails quietly: Stripe rejects the call, its error
response names the permission to add, and the tools print that error in the
API's own words. That is also the proof that no more was ever needed. Verifying
it takes one run, which beats trusting a table, including this one.

**GitHub.** A fine-grained token scoped to your named product repos with
repository **Administration** covers reconcile, the doctor, the audit and the
guards. Reconcile, the doctor and the audit only ever read: collaborators,
invitations, and whether the repo is private. The refund and dispute guards
additionally remove a collaborator and cancel a pending invitation when Stripe
says the money left. The engine guide's
[token section](least-privilege.md#the-github-token-fine-grained-one-permission-named-repos)
has the exact settings and what breaks if you over-restrict.

Issue triage is the only part that writes anything else. It posts a comment and
applies a label on the one public repo you take support issues on
(`ops-bots/bots.js`), so that repo needs write access to issues, and it is the
only reason the token would touch a repo that is not a product. Leave `repo` out
of the config and the bot prints its reason and moves on, with the guards still
running:

```
bots: issue triage off, no "repo" in config; refund and dispute guards run
```

**The guard's own secrets.** The scheduled guard is a workflow for your private
ops repo. It takes a read-only Stripe key and the same GitHub token, runs the
audit and the reconciler four times a day, and its whole write surface is issues
in that one repo (`guard/workflows/guard.yml`). A run where Stripe or GitHub did
not answer is reported as a run the guard could not see, never as a green one.

## Where the rest is

- [What every module prints](pro-evidence.md), in its output format, including
  [the audit on a store with four ordinary mistakes in it](pro-evidence.md#audit-the-standing-guard-on-a-store-that-looks-fine)
  and [reconcile naming an order that took money and delivered nothing](pro-evidence.md#reconcile-what-a-run-tells-you).
- [The full failure catalogue](failure-catalogue.md), free, with the incident or
  defect behind each entry and the gaps still open.
- [The license module's complete API surface](pro-evidence.md#the-license-module-api-surface),
  which is independent of all of the above and works the same whether you run
  the engine or not.
- [Buy HonorBox Pro, $29](https://honorboxx.github.io/honorbox/honorbox-pro.html).
  Thirty days to change your mind, refunded through Stripe.
