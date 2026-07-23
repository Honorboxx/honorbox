<!--
  Generated. The body below is the output of `node audit/audit.js --catalogue`
  in HonorBox Pro, copied here verbatim so the catalogue is readable without
  buying anything. Regenerate rather than editing this file by hand.
-->

> **This is the free half of HonorBox Pro's conformance suite.** The catalogue is
> the knowledge: every way this architecture is known to lose money quietly, with
> the incident or defect that put each entry on the list. It is published in full
> because knowledge stops being scarce the moment anyone prints it, and we would
> rather be the ones who did.
>
> What Pro sells is the other half: sixteen checks that run these against your own
> store on every push, each one proven able to fail, wired to a CI gate that goes
> red the day your setup drifts into one of them. Reading a list once and having a
> gate that will not let you regress are different things.
> [HonorBox Pro](https://honorboxx.github.io/honorbox/honorbox-pro.html) ·
> [what the suite prints](pro-evidence.md#audit-the-standing-guard-on-a-store-that-looks-fine)

# The failure catalogue

Every way this architecture is known to lose money without telling you.

This file is generated from `audit/lib/catalogue.js` (the same data the
checks run against) by `node audit/audit.js --catalogue`. It is meant to be
worth reading even if you never run the tool.

**13 entries.** 5 are incidents that happened on this store's own
infrastructure. 4 are real defects we shipped and caught by execution before
a buyer hit them. 4 have never happened here and are labelled as such: they are
guarded because the first occurrence would be unrecoverable and invisible.

Every one of these was caught on our own infrastructure by running the thing,
not by a customer losing money. Several would have cost one. This store is new,
and anyone telling you a new store has a decade of war stories is selling you
something.

---

## A paid checkout that matches no fulfillment grant

`uncovered-link` · shipped defect: real bug, reproduced, no victim · 2026-07-20
· evidence: honorbox@f3abd67
· cost: none, zero occurrences on the live account

The engine matches a paid Stripe session to a grant by payment link id or
price id. A session that matches nothing was DROPPED, not logged, not
counted, not failed. The run printed "new_paid=0", exited 0, and every
dashboard agreed the store was healthy, while the money sat in the account
and the buyer waited for access that was never coming.

What makes this the worst one in the catalogue is the shape of the evidence:
there is none. A failed invite leaves a FAILED line. A bad token leaves a
401. This leaves an ordinary green run. You find it when a stranger emails
to ask where their thing is, and you have no record to check.

The fix warns once per session and remembers which ones it has already
reported. The check here is the pre-emptive half: reconcile tells you a sale
WAS lost, this tells you which of your live payment links WOULD lose one,
before anybody clicks it.

**Checked by:** `uncovered-link`, `unmatched-history` (live)  
**Not checked:** Needs a Stripe key to enumerate your links. Without one, only the historical half runs (from local state).

## An invitation that is never accepted

`expiring-invite` · reasoned guard: has NOT happened here
· evidence: honorbox-pro/PROVEN.md, "our store has never had a pending or expired invitation"
· cost: none, has not happened to us

GitHub expires an unaccepted repository invitation after 7 days. That is
documented behaviour, not a secret. The non-obvious part is architectural:
NOTHING IN THE PIPELINE EVER REVISITS AN INVITATION IT SENT.

The engine invites the buyer and writes the ledger row in the same breath.
From that instant every system you own reports success: Stripe says paid,
the ledger says delivered, the run is green, the invite genuinely was
created (HTTP 201). The buyer has an unopened email. On day 7 the invitation
lapses and the sale becomes a permanent loss that never appears anywhere as
a loss. Your revenue is right, your delivery count is right, and a customer
has nothing.

We have not been bitten by this. We are saying so plainly because the entry
is more useful than the war story: this is the failure you cannot ask an AI
to guard against, since asking requires knowing the gap between "invitation
created" and "buyer has access" exists at all.

**Checked by:** `expiring-invite` (live)  
**Not checked:** Needs a GitHub token with read access to each product repo. Reports UNKNOWN per repo it cannot read, never "clean".

## The checkout URL pasted where Stripe reports an id

`grant-shape` · shipped defect: real bug, reproduced, no victim · 2026-07-19
· evidence: honorbox@b907ff1 (behaviour), honorbox@1793c94 (the docs that invited it)
· cost: none, caught before any seller followed the wrong line

A grant matches on the payment link's ID (plink_...). The buyer-facing
checkout URL (https://buy.stripe.com/...) is a different string for the same
object, and it is the one sitting in your clipboard when you are setting up.
Paste it and the grant matches nothing: every sale of that product is
skipped, silently, with the run exiting 0. It is the same silent-loss shape
as the entry above, arrived at by a much more likely route.

Our own setup docs contained both instructions in different places. Someone
following the earlier line would have built a store that could never deliver
anything, and no local signal would have told them.

Doctor catches this at setup. This check exists because a config edited six
months after setup never goes through doctor again, but it does go through
CI.

**Checked by:** `grant-shape` (static)  
**Not checked:** None. Pure config shape, no credentials, runs on every push.

## A forked store still selling through the original author's checkout

`foreign-checkout` · shipped defect: real bug, reproduced, no victim · 2026-07-19 / 2026-07-20
· evidence: honorbox@68c6fee (guard keyed on one field), honorbox@9423abe (guard defeated by cosmetic edits)
· cost: none, but the failure mode is other people's money landing in our account

Clone a store, edit it, deploy it. The config's payment link ids get
updated because they are obviously yours to change. The product pages keep
the original author's checkout URLs, because a URL in a markdown file does
not look like configuration. Result: a working storefront whose buy button
sends the operator's customers to the ORIGINAL AUTHOR'S Stripe account.
Their money, someone else's balance.

Every local signal is green. The config is well-formed. The build exits 0.
Doctor passes: it verifies the config's plink ids, which the forker DID
update, and only checks that the product page URL is SHAPED like a checkout
URL, never that it is yours. Nothing short of asking your own Stripe account
"is this link mine?" can see it.

We shipped a guard for this and then found the guard was worse than its own
comment claimed, twice. First it keyed on a single config field that our own
setup docs did not tell people to edit, so it stayed silent for exactly the
seller it existed to stop, verified by building a copy edited to the letter
of the docs: exit 0, hero button pointing at our checkout. Then, once that
was fixed, it compared URLs as exact strings, so a fork that appended
?utm_source=hn, added a trailing slash, or changed the case walked straight
past it with a green build.

That second bug is why this entry ships two checks. One asks your Stripe
account whether the links you sell through are yours. The other reads your
own guard code for exact-string URL comparisons, because a gate that can be
defeated by a query string is a gate that reports it is protecting you.

Then the check written to catch that bug was found to have its mirror image.
It compared whole URL strings, so a seller's OWN link carrying an analytics
tag, or one of the query parameters Stripe documents you appending to your
own links, was reported as somebody else's checkout: a build-failing
accusation of diverting customers' money, levelled at a correct store. Wrong
in the opposite direction to the original, and worse, because the first thing
that store's operator learns about this suite is that it lies. A payment
link's identity is its host and its path; everything after them is decoration
the operator is expected to add. Three bugs on one guard, in two directions,
is the honest measure of how easy this is to get wrong by hand.

**Checked by:** `foreign-checkout`, `url-gate` (live)  
**Not checked:** Only matches links on buy.stripe.com. A custom checkout domain reports UNKNOWN with instructions, never a pass.

## A buy button that no longer sells what the page says, or anything at all

`storefront-drift` · reasoned guard: has NOT happened here · 2026-07-20
· evidence: measured on this account: a deactivated payment link and its live twin returned byte-identical HTTP responses
· cost: none, and the reason is luck rather than design: our own pages happen to point at the live links

A product page makes two promises. This is where you pay, and this
is what it costs. Both are edited in a markdown file. Neither is edited in
the same place, at the same time, or by the same kind of action as the
payment link standing behind them, and until now nothing had ever compared
the two.

Deactivate a link in the Stripe dashboard and the page keeps the URL. Change
a price in Stripe and the page keeps the number. In both cases every local
signal stays green: the build passes, the site is up, the button is right
there in the middle of the page, and doctor is satisfied because doctor
checks the ids in your CONFIG, never the URL a buyer actually clicks.

Now the part that decides whether you can catch this yourself, and the
reason it is in a catalogue rather than left to the reader. The obvious
defence is to fetch your own buy button in CI and assert 200. That test
passes forever. A deactivated payment link still answers its URL with HTTP
200 and the ordinary Stripe Checkout shell, because the page is a
client-rendered application that only learns the link is dead after it calls
Stripe from the browser. Measured here: the deactivated twin of a live link
on this account and the live link itself returned responses of byte-identical
length, neither containing the price, both containing the same markup. A link
checker cannot tell them apart. An uptime monitor cannot tell them apart.
curl cannot tell them apart. Only the API knows, and nothing was asking it.

So the failure has the shape this catalogue keeps finding: total loss, no
signal anywhere, and a monitoring story that actively reassures you. A dead
button loses 100% of that product's sales for as long as it takes a human to
click their own link. Price drift is quieter and can run longer: charge under
what the page promises and you hand back the difference on every sale you
make, forever, with the money simply never arriving and no line item anywhere
reading "less than expected". Charge over it and the number moves upward
between the button and the card field, which is exactly where a stranger
decides a shop they met five minutes ago is not serious.

Two links for the same product, one live and one archived, differing only in
an opaque id, is not an exotic setup. It is what the dashboard leaves behind
every time you rebuild a link to change something Stripe will not let you
edit in place.

**Checked by:** `dead-button`, `price-drift` (live)  
**Not checked:** Compares the amount, not the billing interval: a monthly price advertised as yearly is not caught. A link with several line items charges a sum with no single page price to compare, and is reported UNKNOWN. A price written as a range, a starting point, or anything else with no single value is declined out loud rather than guessed at.

## A poll cadence that outruns the free tier, then stops delivering

`poll-cost` · incident: happened here · 2026-07-19
· evidence: honorbox@d2dbf4c
· cost: $5.86/month of unadvertised bill on a product whose headline said $0/month

GitHub bills private-repo Actions per job, ROUNDED UP TO A WHOLE MINUTE.
Not per minute of compute, per job. A 15-second fulfillment poll is billed
as one minute, every time.

Our own shipped template polled every 15 minutes into a private ops repo:
2,976 billed minutes a month against a 2,000-minute Free allowance. 976
minutes over, about $5.86/month, on a storefront whose headline read
"$0/month". We did not deduce this from documentation. We measured it on
this org's own metered usage: 44 fulfillment runs of roughly 10-17 seconds
each, billed at exactly 44.00 minutes.

The bill is the small half. The real failure is what happens when the
allowance runs out on the 22nd: Actions stops running, so fulfillment stops,
so buyers stop being delivered to. And the symptom is not an error, it is a
cron that quietly stopped. Nothing in your store reports it. You find out
from a customer.

Fixed by sizing the cadence to the tier (17,47 = 1,488 min/month, 512 minutes
of headroom) rather than by rewording the pricing claim.

Now the other half, because a catalogue that only frightens people is as
useless as one that reassures them. Once the poll is sized correctly the
cliff is much further away than "you will run out" suggests. Work it out for
your own store:

    headroom          = 2,000 - (your poll's billed minutes/month)
    sales you can add = headroom, at ~1 billed minute per sale-triggered run
    cost beyond that  = (overage minutes) x $0.006   [Linux, standard runner]

On the cadence we actually deploy (an hourly poll, a phase-offset hourly
second ticket, and a daily drift check, 1,519 minutes together), that is 481
minutes of headroom, so roughly 480 sales a month before anything is billed
at all, and $3.11 a month at a thousand sales. If your store is doing a
thousand sales a month, three dollars is not the line item you are worried
about.

So the failure this entry describes is real but specific: it bites a poll
sized without doing this arithmetic, not a store that got popular.

**Checked by:** `poll-cost` (static)  
**Not checked:** Recognises the cron cadences people actually write; anything exotic reports UNKNOWN rather than guessing. Cannot read your real remaining balance: that needs a billing-scoped token we deliberately do not ask for.

## A 100%-off coupon on a link that accepts typed codes

`free-coupon` · incident: happened here · 2026-07-20
· evidence: honorbox@ce5aba5
· cost: no unauthorized redemption recorded; exposure was bounded at roughly $87

Two 100%-off promotion codes were live on our own checkout links the day
before we pointed a launch at the store. They existed because that is how
you test a delivery pipeline without moving money. One of them had a
guessable name of the FREETEST-2026 shape.

A payment link with the promotion-code field open is a live discount surface
on a money path. Anyone who types the right string gets the product for
nothing, and the delivery is completely real: the invite goes out, the
ledger records a sale, the run is green. The engine's zero-cost WARN is the
backstop that tells you afterwards. Nobody reads a warning line mid-launch.

We caught it in a pre-launch sweep. No unauthorized redemption is recorded
and the exposure was bounded by the remaining redemption count at roughly
$87, so this is a near-miss with a real live surface rather than a theft. It
is in the catalogue because the setup that produced it (test the pipeline
with a free code, leave the code alive, open the promo field because the
default was open) is what every seller does in their first week.

Fixed by flipping the generated default: promotion codes OFF unless you turn
them on.

**Checked by:** `free-coupon` (live)  
**Not checked:** Needs a Stripe key with read access to coupons, promotion codes and payment links.

## One hung request stalling every buyer behind it

`fetch-timeout` · reasoned guard: has NOT happened here · 2026-07-20
· evidence: honorbox@79a9cc1
· cost: none, measured in a lab, never seen in production

Node's fetch has no overall request timeout. Undici's header and body
deadlines default to 300 seconds each. A server that accepts your connection
and then never answers (not a refusal, not a reset, just silence) holds
the call open.

The fulfillment runner is a SINGLE job. While one cycle is stuck on one
buyer's invite, no other cycle starts, and every buyer queued behind that one
waits with them. A five-minute stall on one stranger's GitHub call is a
five-minute delivery outage for everyone.

Measured, not assumed: a bare fetch against a socket that accepts and never
replies had still not settled after 8 seconds on Node 24, while
AbortSignal.timeout aborted on the dot. We have never had this happen in
production. It is guarded on the assumption that tomorrow a real stranger's
invite does something we have never seen.

The check reads your own money-path sources, because the exposure returns the
moment anyone adds a call, which is exactly the kind of regression a human
review waves through.

**Checked by:** `fetch-timeout` (static)  
**Not checked:** Static scan of the files you point it at. It reads code, so it cannot know whether a file is actually on your money path. Point it at the right ones.

## An unstaged file halting delivery

`rebase-autostash` · incident: happened here · 2026-07-19
· evidence: private ops repo, not publicly checkable
· cost: roughly 6 minutes of skipped delivery cycles, twice, with no order pending

The ops cycle pulls before it pushes. `git pull --rebase` refuses to run
with a dirty working tree, so ONE uncommitted tracked file makes the pull
fail, which makes the cycle exit early, which means fulfillment does not run.

Delivery stops for a reason that has nothing to do with delivery, and the
error message is about git. Nothing in the failure names a buyer, an order,
or a payment. If you are not watching the runner you will not notice, because
a store with no sales in the window looks identical to a store that stopped
being able to deliver.

This has stopped delivery here twice. Both times the culprit was a document,
once a security log a working lane had left unstaged. The fix is one flag,
--autostash, and the reason it is in a catalogue rather than a footnote is
that no amount of care about the money path protects you from it: the file
that halted our deliveries was prose.

**Checked by:** `rebase-autostash` (static)  
**Not checked:** None. Reads the shell scripts you point it at.

## Production running a copy of the engine you stopped reading

`vendor-drift` · incident: happened here · 2026-07-20
· evidence: the private ops repo, not publicly checkable: its incident log records production running stale code
· cost: the live runner printed proof-of-delivery for a delivery that never happened

Vendoring the engine is correct. Pin what you run. The failure is a
vendored copy that DRIFTS, because then production executes a file nobody is
reading any more and every upstream fix silently stops arriving.

Our ops repo vendors its own copy of the engine and was two commits behind.
The 201/204 logging distinction that our own operations document recorded as
DONE existed only in the public engine. The live runner was logging a 204 as
"invited X -> repo": printing proof of a delivery that had not happened,
into the log we would have used to investigate a complaint.

The compounding detail is what earns this its entry. We had fixed the
logging bug. We had written down that we fixed it. Both were true. And the
thing actually taking people's money was running neither, and nothing
anywhere disagreed with us.

The check compares copies of the same engine module and reports any that
differ. Which one is correct is your call, not ours: the finding is that
two exist and disagree.

**Checked by:** `vendor-drift` (static)  
**Not checked:** Compares copies against each other, not against upstream. It cannot tell you which is current without network access we do not take by default.

## HTTP 204 logged as if it were a fresh invitation

`invite-status` · incident: happened here · 2026-07-19
· evidence: honorbox@bbbbe1a
· cost: none directly, but it is the log line you would investigate a complaint with

GitHub answers PUT /collaborators with 201 (invitation created) or 204
(already a collaborator). Both mean the buyer has access, so both are
success, and for a long time the log flattened them into "invited".

Seen for real in a live end-to-end run, which logged
"invited <account> -> <product repo> (HTTP 204)" when no invitation had been
created at all. (Account sanitized: it was our own test identity, but a log
line naming a person belongs in our logs, not in a published document.)

Two costs. A seller's own test purchase prints a line that reads exactly like
a real stranger's delivery, so your first successful test is a lie you told
yourself. And when a buyer writes to say no invitation arrived, you cannot
tell their case apart from someone who already had access: the one log line
that could settle it says the same thing for both.

Honest caveat: our test identity owns the product repos, so it can ONLY ever
hit 204. That is how we found it, and it is also why it never cost us a
customer.

**Checked by:** `invite-status` (static)  
**Not checked:** Heuristic. It reads whether your invite code tells the two statuses apart, and can be fooled by an unusual style.

## A buyer flagged for attention that nothing ever tells

`needs-attention` · reasoned guard: has NOT happened here
· evidence: honorbox@582f119 (the 404 hint); no real buyer has ever mistyped a username here
· cost: none, has not happened to us

A buyer types a GitHub username that is valid in shape but belongs to
nobody. GitHub returns 404. The engine correctly refuses to retry forever,
writes needs_attention on the ledger row, and moves on. That is right: an
infinite retry on a permanent error is worse.

The gap is on the other side. The OPERATOR is notified: the row is flagged,
the playbook covers it. The BUYER is not. They have paid, they are waiting,
and the only record of their situation is a boolean on a row in a JSON file
that nobody opens unless they already suspect something.

So this check does something deliberately unglamorous: it reads your ledger
and prints the people who paid you and got nothing, with the age of each. It
is a list of humans to email, which is the actual remedy.

We have not had a real buyer mistype a username. This entry is a guard, not a
war story, and the provenance line above says so rather than leaving you to
guess.

**Checked by:** `needs-attention` (static)  
**Not checked:** None, but it only sees what your ledger recorded. A failure that never reached the ledger is reconcile's job, not this one.

## A force-push guard that fails open on the short spelling

`force-push-guard` · shipped defect: real bug, reproduced, no victim · 2026-07-20
· evidence: a private sibling repo, not publicly checkable: the guard matched --force but not the leading-plus refspec
· cost: none, no buyer was affected; the control was advertised in a README

A git hook in one of our own buyer-facing products advertised, in its
README, that it blocks force pushes. Its own header said it fails closed.

`git push origin +main:main` returned exit 0. A leading + on a refspec is a
force push (git-push(1) says "equivalent to --force"), and the guard only
tested for the --force and -f tokens, so the flagless spelling walked
straight through the one control the product named. It was reproduced by
RUNNING the hook, not by reading it, which is the only reason it was found:
the code reads correct.

A second bug surfaced from the test written for the first: --force-with-lease
against a protected branch was also allowed, because the protected-branch
pattern held a bare name and its trailing boundary excluded hyphens, so it
matched only a branch named exactly that and not its release-1 sibling.

This one is in the catalogue for a reason beyond git. It is the clearest
example of a guard that inspection approves and execution rejects, in a
product we sold, in a control we advertised. It is why every check in this
suite has a test that breaks the thing and proves the check goes red.

**Checked by:** `force-push-guard` (static)  
**Not checked:** Heuristic: it looks for a guard that handles the flags but not the refspec form. It cannot prove YOUR hook is sound. Run it, the way we should have.

---

## Gaps we have not closed

A catalogue containing only solved problems is an advertisement.

### A 200 that acknowledges dispatch, not delivery

In webhook mode a relay accepts Stripe's event and returns 200 as soon as
the DISPATCH succeeds. Stripe is then satisfied and will not retry. But
"dispatch succeeded" says nothing about whether the invitation succeeded:
those are different systems and the second one has not been consulted yet.

This is a real gap in our own architecture and it is open by a deliberate
decision. We are listing it because a catalogue that contains only solved
problems is marketing.

Two things stand behind the relay, and both are narrower than they sound.

The first is in-run retry. A transient invite failure is retried inside the
run, waiting exactly as long as GitHub's retry-after header asks, but only
up to 30 seconds per wait, 60 seconds across the whole run, and 3 attempts.
Those ceilings are deliberate: a PRIMARY rate limit says "come back in 50
minutes", and sleeping through that would hold the run open for an hour. So
anything longer is DECLINED and falls through to the poll. In-run retry
covers a short secondary throttle. It does not cover a primary limit, a long
outage, or a GitHub incident.

The second is the scheduled poll, which re-scans a 25-hour window. The
temptation is to call that "one poll interval" and move on. Our own
operations notes say otherwise: GitHub's scheduler oversleeps badly on quiet
private repos, and we have recorded a */10 schedule collapsing to roughly one
fire per hour with gaps as long as 3 hours 8 minutes. That is why we run two
independent scheduled workflows at distinct off-peak minutes: each is a
separate lottery ticket against the same oversleep. So the honest bound is
not the interval you configured; it is the next poll that actually fires,
and we have measured that at over three hours.

And a precondition worth stating plainly, because it interacts with another
entry in this catalogue: the poll IS the backstop. An operator running
webhook-only, or who trimmed their cadence to stay inside the Actions free
tier, has removed the thing that recovers a dropped dispatch. Do not let this
entry and the poll-cost entry combine into advice that quietly deletes your
own safety net.

**What runs instead:** A short secondary throttle is retried in-run (30s per wait, 60s per run, 3 attempts); anything longer, including a primary rate limit, is declined by design and falls to the scheduled poll, whose real recovery time is the next run that actually fires, measured here at up to 3h08m on a quiet private repo.

