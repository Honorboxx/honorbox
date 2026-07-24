---
id: honorbox-pro
order: 1
name: HonorBox Pro
meta_title: "HonorBox Pro ($29): find the orders that never landed"
description: Walks every paid Stripe order against live GitHub access and names the ones that never reached the buyer. Runs on a store you wired yourself. $29.
tagline: A GitHub repo invitation expires after seven days, and nothing in Stripe will ever mention it. Pro walks every paid order against live GitHub access, names the ones that never landed, and keeps asking on a schedule. Point it at the setup you already run.
price: $29
price_note: one developer, one-time · team and company licences below
payment_link: https://buy.stripe.com/aFa9ATaRhaZp3PC1SYa7C00
# Social card, named explicitly. The gallery below is WebP for the browser,
# which link-preview scrapers do not reliably render, so the card keeps a PNG.
# This was previously whatever image happened to be first in the body; naming
# it makes it a decision rather than a side effect of editing the gallery.
og_image: ./assets/previews/stand.png
features:
  - "Bring your own store: runs against a hand-rolled Stripe + GitHub setup from a minimal config naming your existing payment links and repos, no engine adoption; engine-layout checks skip and print why"
  - "Reconcile: cross-checks Stripe against GitHub to prove every paid order actually reached its buyer, and names the ones that didn't"
  - "Conformance suite: 16 checks for the known ways this architecture loses money quietly, each proven able to fail, wired to a CI gate that goes red when your setup drifts"
  - "Catches a dead buy button (a deactivated link still answers HTTP 200), a price on the page that differs from what the link charges, a pasted URL that makes every sale unmatchable, and a live 100%-off coupon"
  - "Scheduled guard: a drop-in Actions workflow that runs the suite and reconcile four times a day and raises one self-closing GitHub issue in your ops repo naming exactly what went red. A run that could not reach Stripe alarms too; it never reads as healthy"
  - "Store doctor: preflight your config, payment links, and fulfillment permissions before launch"
  - "Ops bots: auto-acknowledge new support issues, auto-revoke repo access on a Stripe refund or a lost chargeback"
  - "Stats: tracker-free sales analytics rendered from your Stripe data, one command"
  - "The rail storefront theme, a fixed left navigation column, built to the same class contract as the free themes"
  - "License-key module: ed25519 keys signed in CI, verified offline in your app (JS + Python)"
  - "Commerce playbook: pricing, the first ten sales, EU VAT, multi-product catalogs (table of contents is public)"
  - Priority support label on the issue tracker
---

30 days to change your mind, no questions asked, refunded through Stripe.
[The refund policy in full](./refunds.html).

Launch week: code `PRODUCTHUNT` takes 20% off at checkout, through August 20.

## What Pro is

Someone paid you and never got in. You would find out when they email you, if
they email you.

Every expensive failure in this architecture has that shape: the money arrives,
the delivery does not, and nothing anywhere says so. An invitation nobody
accepts expires after seven days, and unless something re-issues it before then
the sale is gone with nothing recording that it was ever at risk. A refund
returns the money and leaves the collaborator in place, and a lost chargeback
does the same. A payment link that went into your config as a URL where Stripe
reports a `plink_` id makes every sale of that product match nothing at all.
Stripe says paid, GitHub was never asked, and the only buyer who tells you is
the one who cared enough to chase.

**Pro is the thing that asks instead.** Reconcile walks every paid Stripe
session and asks GitHub whether that specific buyer holds access to that
specific repo right now: one verdict per order with the amount attached, and a
non-zero exit when anything is lost, so you can schedule it rather than remember
it. Alongside it, a conformance suite of sixteen checks for the known ways a
Stripe-plus-GitHub store loses money without telling you, run against your own
account and wired to a CI gate.

And because the ways a store breaks do not arrive by push, the asking runs on
a clock as well as a gate: a scheduled guard re-runs the suite and the
reconciler four times a day and raises an issue in your own repo the day
something goes red, so a silently broken store becomes a loud notification
within hours instead of a theory you form weeks later from an absence of
sales.

If you have not launched yet, you have the same problem one step earlier. An
empty ledger looks identical whether nobody came or the store is
quietly broken, and almost every way this architecture fails returns a
perfectly healthy-looking response: a payment link you deactivated still answers
its URL with HTTP 200 and the ordinary Stripe checkout page, so a link checker,
an uptime monitor and a `curl` in CI all agree your dead buy button is fine.
Only the API knows, and nothing is asking it. Most of the suite's checks need no
orders at all, which is the point: they are useful on the day you launch, not
after you have lost something.

Around both sits the rest of the operational half: the store doctor catches
setup mistakes before they cost you a launch, and the refund guard revokes what
a refund should revoke without waiting for you to run a command.

## It runs on the store you already have

You made your payment links in the Stripe dashboard. You deliver by inviting the
buyer to a private repo, with glue you wrote once and have not opened since.
That is the setup this was built for, and you do not have to adopt the engine to
put Pro on it. Write a minimal config naming the payment links and product repos
you already have, and add one custom field to your payment link asking for the
buyer's GitHub username: a two-minute edit in the Stripe dashboard, and the link
URL does not change, so nothing you have already published goes stale and no
buyer sees a difference. Reconcile, stats, the refund and dispute guards, the
store doctor and the suite's money-path checks then run in full against your
setup as it stands.

Straight about the parts that do not. Checks written for the engine's own
storefront layout skip, print the reason, and are counted apart from the passes
rather than quietly passing. No ledger is required, and with none there the two
history checks step aside and reconcile answers the same questions from live
Stripe and GitHub state instead. The suite is young: it
catches what has been catalogued and nothing else. Check all of that before you
pay rather than after:
[what runs on a store you built yourself](./bring-your-own-store.html)
has the config, the checkout field, the modules that run in full, the ones that
step aside with the lines they print, and the limits. If you later want the
storefront and the fulfillment glue too, adopting the engine is a config file
naming those same links and repos, not a migration your buyers can see.

**You could write the diff yourself in an afternoon.** The reason to buy this
instead is what the homemade version does when it is wrong. A check that
compares paid sessions against collaborators gets the cases that matter
backwards: a pending invitation looks like a loss, an expired one looks
identical to a pending one, a refunded buyer who still holds access looks
delivered, and if one payment link went in as a URL where Stripe reports an id,
nothing matches at all and the run reports zero failures. **A reconciler that
matches nothing reports everything clean.** That is not a hypothetical we are
selling against: the first version of one check in this suite could not be made
to fail at all, and what found it was a mutation suite that breaks each check on
purpose and requires it to go red. Every check has to survive that now, which is
the part you are actually buying.

## Who should buy this (and who shouldn't)

**Buy Pro if** you are already taking orders and want each one proved delivered
rather than assumed. Buy it too if you have a store set up and a launch coming,
and you would rather find out now than infer it later from an absence of sales:
you get one launch, and a misconfigured grant or a dead buy button burns it
while every local signal tells you the store is fine. Buy it if you sell or plan
multiple products, if your product runs on machines you cannot see and needs
license keys, or if you want a storefront that doesn't look like every other
fork.

Delivery is a private repo, so read the box before you buy it. Public and
checkable right now: the license module's
[full API surface](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md#the-license-module-api-surface)
with the key format and both verify snippets, the playbook's complete table of
contents,
[what every module prints](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md),
in its real format, and
[what runs on a hand-rolled store](./bring-your-own-store.html),
so you can see the answer each one gives before you pay for the code behind it.

**Skip Pro if** you have not actually set a store up yet. There is nothing for
the suite to check, and the free core is a complete store on its own. Skip it if
you're selling one PDF or template, or if you're happy in CSS and would rather
restyle the free theme yourself, which the theme contract makes easy.

And skip it if you are buying it to feel like you have started. That is the most
common reason anyone buys a tool like this and it is the wrong one. The suite is
worth $29 when there is a real store with real money moving through it, or a
real launch date for one. It is worth nothing as a substitute for having either.

## What's inside

**The conformance suite.** The largest thing Pro ships. It reads your config and
your sources, and with a read-only Stripe key it asks the API about the objects
behind them. Some of what it catches:

- a **dead buy button**: a deactivated payment link answers HTTP 200, so nothing
  else you own will notice
- **price drift**: the number printed on your product page against the number
  its link actually charges, in the right minor unit for the currency, declining
  to guess when the page says something like "from $19"
- a **pasted checkout URL** where Stripe reports a `plink_` id, which makes every
  sale of that product silently unmatchable
- a **forked store** still selling through the original author's checkout, which
  banks your customers' money into someone else's account
- a live **100%-off coupon** on a link that accepts typed codes
- a **poll cadence** that outruns the Actions free tier and then stops delivering
- **no request deadline** on a money-path `fetch`, where one hung socket stalls
  every buyer queued behind it

It is static analysis, configuration checking and read-only API reads. It does
not execute your code and it cannot see a failure nobody has catalogued. Where it
could not check something it prints `UNKNOWN` and the reason, never `OK`, because
a suite that silently skips what it cannot check is worse than no suite: it
produces a clean report about a store nobody examined. There is no score, because
a number would invite you to feel 82% safe and there is no such thing here.

Every check is proven able to fail. A mutation suite builds a correct store,
asserts it is green, breaks the exact thing each check guards, asserts that check
goes red, and asserts it returns to green on revert. A check that cannot be made
to fail is decoration. This is not ceremony: the first version of one check could
not go red at all, because the code pattern it scanned for satisfied its own
test, and running the mutation suite is what found it.

[**The full failure catalogue is published free**](https://github.com/Honorboxx/honorbox/blob/main/docs/failure-catalogue.md):
thirteen entries, each with the incident or defect that put it on the list, and
the gaps we have not closed. Take it, post it, work through it by hand. What Pro
sells is the part that keeps working after you have stopped thinking about it.
[See exactly what the suite prints](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md#audit-the-standing-guard-on-a-store-that-looks-fine),
on a store with four ordinary mistakes in it.

**The `rail` theme.** A fixed left navigation column instead of a centred page:
the store's structure stays on screen while the reader moves through it, which
is what a catalogue of any size actually needs. Complete and hand-tuned, with
fluid type, visible focus states, print styles, and a light and dark palette
built as mirrors. Switch with one config line.

We shipped one theme here rather than a pack. Four others were built and cut,
because a theme that does not hold up is worse than no theme in something you
paid for. The free repo's `stand` and `terminal` are built to the same class
contract and can be read in full before paying for anything.

![rail theme, fixed left navigation column on ink](./assets/previews/rail.webp)
![stand theme, monochrome and centred](./assets/previews/stand.webp)
![terminal theme, phosphor on green glass](./assets/previews/terminal.webp)

**The store doctor.** One read-only command that checks your whole pipe:
config shape, the pasted-URL-instead-of-id mistake, whether your payment links
are live, whether your fulfillment token can actually invite buyers, whether
your product repo is accidentally public. Run it before launch; sleep after.

**Reconcile.** Doctor checks that your store is set up right, which you ask once.
Reconcile answers the question that only starts costing money after launch: for
every order you were *paid* for, does that buyer have the product *right now*?

Those are different questions, and the free engine does not answer the second
one. It writes its ledger row the moment it **sends** an invite, so a buyer who
never clicks accept leaves every system you own reporting success: Stripe says
paid, your ledger says delivered, the run is green. They have nothing.

The engine will not let that invitation lapse quietly. It re-issues an
unaccepted one before GitHub's seven-day expiry, three times, then warns you by
name: about three and a half weeks of open door, and it is part of the free
engine, because a sale that never lands was never delivered
([how that works](https://github.com/Honorboxx/honorbox/blob/main/docs/how-it-works.md#delivery-model)).

That is also where it stops. Renewal works from GitHub's list of pending
invitations and holds
[no Stripe key at all](https://github.com/Honorboxx/honorbox/blob/main/scripts/renew-invites.js),
so it can keep an invitation alive but never tell you which *paid order* it
belongs to, or how much money is sitting undelivered. And it never sees a
failure that left no invitation to renew: an order that matched no grant, a
typo'd username the engine flagged and skipped, a refunded or charged-back
buyer who kept access.

Reconcile starts from the money instead. It walks every paid Stripe session and
asks GitHub whether that specific buyer holds access to that specific repo: one
verdict per sale with the amount attached, `PAID, NO GRANT` on an order the
engine never fulfilled, a repo it cannot read reported as unreadable rather than
counted clean, and a non-zero exit when anything is lost, so you can schedule it
instead of remembering it. Read-only.

It also separates revenue from fulfillments: a $0 order fulfilled by a coupon
is a delivery, not a sale, and reconcile reports them apart so your revenue line
means money that actually arrived.

**The scheduled guard.** The suite and the reconciler exit non-zero when
something is wrong, and an exit code is only an alarm if something watches it.
The guard is a ready-to-copy GitHub Actions workflow for your private ops
repo: on a schedule it runs both against your live store, and when anything
goes red it opens **one** GitHub issue naming the exact failing checks and
undelivered orders, with the fixes. The same issue updates while things stay
red, a change posts a comment so it notifies, and it closes itself on the
first green run. A run where Stripe or GitHub did not answer is reported as
"the guard could not see", never as a green run. No server, no webhook, no
third-party monitor holding your keys: GitHub already notifies you about
issues in your own repo, and the guard gives it something true to say.

**Ops bots.** Two workflows for the unattended hours. One acknowledges and
labels every new support issue within minutes. The other watches Stripe for
refunds and revokes the buyer's repo access and pending invites the moment one
lands.

**Stats without trackers.** One command renders gross, net, AOV, refund rate,
revenue by week, and buyers by country into a single offline HTML report,
computed from your Stripe account. Your storefront never loads an analytics
script.

**Multi-product patterns.** The engine sells several products out of the box.
The playbook chapter covers what breaks after that: why each product wants its
own private repo, how to build a bundle that grants several repos from one
payment link, how a refund revokes what that purchase granted and nothing
else, and the order you retire a product in so a checkout completed a minute
before deactivation still gets fulfilled.

**The license-key module, if you need it.** A GitHub Action that signs an
ed25519 license for each buyer at fulfillment time, plus drop-in verification
snippets for JavaScript and Python. Your app checks licenses **offline**: no
license server, no phoning home, nothing to keep running. Signing happens in CI
with the private key held as an Actions secret.

Worth being straight about who this is for. HonorBox delivers entitlement as
repo access, and **if your entitlement is repo access you do not need a license
key at all.** This module is for sellers whose product is installed somewhere
else and has to check for itself: a desktop app, a plugin, a CLI that runs on a
machine you will never see. That is a real need for a real minority, and it is
the least representative thing Pro contains, so it is down here rather than at
the top. Its
[complete API surface](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md#the-license-module-api-surface),
key format and both verify snippets are published, so you can judge it before
paying.

**The commerce playbook.** Four documents: picking your number against real
comparables, running a launch price you can honor, the first ten sales of a
store nobody has heard of, and an EU VAT primer with two worked registration
examples. Every chapter title and a one-line summary of each is
[published](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md#the-commerce-playbook)
so you can see the shape of it before paying.

## How delivery works

Checkout asks for your GitHub username. The fulfillment bot invites that
account to the private `Honorboxx/honorbox-pro` repository, usually within
minutes and always within a few hours. You keep access permanently; updates
land in the same repo. It's the same private-repo delivery we recommend in
[the GitHub delivery guide](./deliver-digital-products-github.html), so you're
watching the engine you'd be buying.

## Licences

Pro is licensed per developer. If more than one person on your team will read
or run it, the team licence is cheaper than buying copies, and it is meant to
be: we do not enforce this with keys or phone-homes, so it has to be easier to
obey than to ignore.

| | Price | Covers |
|---|---|---|
| **Solo** | $29 | one developer, unlimited projects of your own or your clients' |
| **Team** | $99 | up to 5 developers at one company |
| **Company** | $249 | every developer at one company, and the licence transfers with the company rather than dying with an employee |

Solo is the buy button on this page. For **Team** and **Company**, email
[honorbox@proton.me](mailto:honorbox@proton.me) and you will get a checkout link
and an invoice made out to the company. Each seat is a GitHub account invited to
the private repo, so send the usernames with the order or afterwards, whichever
suits.

## Terms

- One-time. No subscription, no upsell treadmill.
- **Updates:** every update to Pro v1 is included at no extra cost, and lands in
  the repo you already have access to. A future v2, if there ever is one, would
  be a separate purchase. We would rather write that down now than surprise you
  with it later.
- Licensed per developer at the tier you bought. Use it in any number of your
  own stores.
- Don't republish or resell the Pro content itself.
- 30-day refunds, no questions asked, via Stripe.
- Support through GitHub issues; Pro buyers get the priority label.
