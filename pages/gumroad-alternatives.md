---
title: Gumroad alternatives for developers (2026): fees and trade-offs
description: Gumroad alternatives for developers: Polar, GitPaywall, Lemon Squeezy, Payhip, Paddle, plain Stripe, and DIY, with real fee math and when each one wins.
---

The Gumroad alternatives worth a developer's time in 2026 (Polar, GitPaywall,
Lemon Squeezy, Payhip, Paddle, plain Stripe, and full DIY), with the real fee
math. Disclosure up front: we build one of the options, and the two listed
first are the ones that compete with us most directly. The numbers are real
either way; check them against each platform's pricing page before deciding.

## What a Gumroad alternative has to replace

Selling digital products means picking who handles four jobs: **checkout**,
**delivery**, **tax**, and **trust**. Platforms bundle all four and charge for
the bundle. The alternatives differ mainly in which jobs you take back.

## The merchant-of-record platforms

**Gumroad** charges 10% + 50¢ per sale on your own traffic, with no monthly
fee. Payment processing (2.9% + 30¢) is charged on top, per
[their own fee page](https://gumroad.com/help/article/66-gumroads-fees), and
sales via their Discover marketplace cost 30%. The simplest start there is:
upload a file, share a link. It's a merchant of record, so EU VAT and US
sales tax stop being your problem. Roughly 13% + 80¢ per direct sale is the
price of never thinking about any of it.

**Lemon Squeezy** charges 5% + 50¢ with processing included, plus small
surcharges (+1.5% international cards, +1.5% PayPal, +0.5% subscriptions).
Also a merchant of record, with more developer polish: license keys, checkout
overlays, an API. Owned by Stripe since 2024. Well under half Gumroad's real
cut at most price points, and the same core trade: they're the seller, you
invoice them.

**Polar** ([fees](https://polar.sh/docs/merchant-of-record/fees)) is the
closest thing to what we build, and the honest place to start if you sell
through GitHub. Its free tier is 5% + 50¢, processing included, with paid
plans trading a monthly fee for a lower percentage. It is a merchant of
record, so VAT is handled. The part that matters here: private GitHub
repository access is a
[built-in benefit](https://polar.sh/docs/features/benefits/github-access).
You authorize their GitHub app, pick a repo, and buyers are granted
collaborator access automatically, with access revoked when they cancel or
refund. That is the same job HonorBox does, done instantly instead of on a
poll, with your tax handled. If that sounds like what you want, take it; the
engine is open source (Apache-2.0) and the project is around 10k stars.
Figures checked July 20, 2026.

**Payhip / Sellfy / Podia** are the same shape with different fee dials
(Payhip has a 5% free tier with paid plans down to 0% + monthly; Sellfy and
Podia are monthly-fee platforms). Worth a look if you want a storefront
builder with more retail features than developer features.

**Paddle** is a merchant of record aimed at SaaS, at roughly 5% + 50¢.
Overkill for selling a $29 zip; right-sized for subscription software with
real tax exposure.

## Selling without a merchant of record

These keep you as the merchant, which means you keep the platform's cut and
inherit its tax job.

**GitPaywall** is the other purpose-built option for repo access: gate a repo
behind a payment and buyers get collaborator access the moment they pay,
roughly 5% through Stripe Connect. It is not a merchant of record, so tax
stays with you. That makes it the closest comparison to HonorBox on tax, and
the closest to Polar on delivery speed.

**Stripe Payment Links alone** cost Stripe's standard processing fee and
nothing else. You get checkout in five minutes
([our complete guide](./sell-with-stripe-payment-links.html) walks through
it). What you don't get: delivery. A payment link can show a confirmation
message, but nothing grants the buyer access to anything. Most sellers bolt
on a server, a webhook, and a mailer. Congratulations, you run infrastructure
now.

**HonorBox** ([this site](./index.html)) is our attempt at keeping the
Payment Links economics without running infrastructure: a static storefront
on GitHub Pages, checkout through your own Stripe account, and a scheduled
GitHub Action that polls Stripe and invites each buyer's GitHub account to a
private product repo. 0% platform fee, $0/month, no server. The costs,
plainly: delivery is a repo invite that lands in minutes; your buyers need
GitHub accounts (fine for code, templates, and courses aimed at technical
people, wrong for lay-reader ebooks); and **you are the merchant, so tax is
yours**. Under most registration thresholds that's simpler than it sounds;
[our tax doc](./tax.html)
covers it without hand-waving. The engine is MIT-licensed and
[open to read](https://github.com/Honorboxx/honorbox).

The difference against Polar, since it does the same delivery job: Polar is
faster (instant, not a poll) and carries your tax, and for most sellers that
is the better deal. What you get here instead is that the Stripe account, the
balance and the customer relationship are yours, there is no platform account
to be declined for or removed from, and the whole fulfillment path is two
files you can read and fork. That trade is worth making at volume, or when you
want it on principle. It is not worth making at ten sales a month.

## A decision rule that mostly works

- Selling to **general consumers**, or want zero tax thoughts → Gumroad or
  Lemon Squeezy. The fee is real but so is the service.
- Selling **a handful of copies a month**, whatever the product → a merchant of
  record. The percentage you'd save is a couple of dollars, and VAT compliance
  costs more than that in time alone. Polar or Lemon Squeezy.
- Selling **through GitHub and you want tax handled** → Polar. Native repo
  access, instant, revoked on refund, and they are the merchant of record.
- Selling software that needs **seats, metered billing, or a hosted customer
  portal** → Lemon Squeezy or Paddle.
- Selling **code, templates, boilerplates, courses, or tools** to people who
  have GitHub accounts, at enough volume that the percentage beats the
  paperwork, or because you want the Stripe account and the customer to be
  yours → [Stripe Payment Links](./sell-with-stripe-payment-links.html) +
  HonorBox.
- Already have a backend and a mailer → plain Stripe and your own glue; you
  don't need any of us.

## The fee math at a glance

Total fees each month on a $29 product, US domestic cards. Lemon Squeezy's and
Polar's cuts include processing; Gumroad's 10% + 50¢ has processing
(2.9% + 30¢) on top; HonorBox adds $0 to Stripe's rate. Polar's free tier and
Lemon Squeezy are both 5% + 50¢, so they land in the same place:

- **10 sales ($290/mo)**: Gumroad ~$45 · Lemon Squeezy or Polar ~$19.50 · HonorBox ~$11 (Stripe's fee only)
- **50 sales ($1,450/mo)**: Gumroad ~$227 · Lemon Squeezy or Polar ~$97.50 · HonorBox ~$57 (Stripe's fee only)
- **100 sales ($2,900/mo)**: Gumroad ~$454 · Lemon Squeezy or Polar ~$195 · HonorBox ~$114 (Stripe's fee only)

Read the first row before the third. At 10 sales the gap against a merchant of
record is about $8 a month, which is 81¢ a sale, and for that $8 they are doing
your VAT. That is not a good trade, and we would rather say so here than have
you work it out after switching. The gap only becomes an argument around the
50-sale row and a real one at 100.

Per-sale math with every number sourced:
[Lemon Squeezy vs Gumroad vs DIY (2026)](./lemon-squeezy-vs-gumroad-vs-diy.html).

## Related

- [Lemon Squeezy vs Gumroad vs DIY (2026): fees compared](./lemon-squeezy-vs-gumroad-vs-diy.html)
- [Sell code without a marketplace: the direct Stripe + GitHub route](./sell-code-without-a-marketplace.html)
- [Sell digital products with Stripe Payment Links: the complete guide](./sell-with-stripe-payment-links.html)
- [Deliver digital products through GitHub: the practical guide](./deliver-digital-products-github.html)
- What this store sells with its own engine: [HonorBox Pro ($29)](./honorbox-pro.html)
  and [Crew ($19)](./crew.html)
