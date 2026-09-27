# email-concierge — 2-minute explainer video treatment

**Purpose:** AWS Forward Deployed Engineer interview reel. Audience is a technical
evaluator, not an end user — the video's job is to demonstrate AWS
solutions-architecture judgment, using the working UI as proof-of-life, not as
the main event.

**Runtime:** ~120s. **Format:** Remotion composition, 1920x1080, 30fps.
**Narration:** ElevenLabs TTS, "Jess" voice, one continuous VO track.
**Captions:** per-beat title/subtitle cards (the decision + its one-line why),
not a scrolling word-for-word transcript — see Scene 2's caption spec and the
Remotion notes below for exactly what's on screen.

**Structure:** 20s cold-open UI proof → 100s architecture-decision reel (6 beats,
~16–17s each) over one persistent, animated system diagram.

---

## Asset inventory

The live app's list API (`services/api-lambda/src/index.ts`) does an
unfiltered `ScanCommand` over the whole `emails` table — there is no
fixture-only view, so a screenshot of the real deployed app always risks
showing real inbox rows mixed in with fixtures, no matter which email is
selected in the detail pane. (An earlier pass at these assets learned this
the hard way — the queue *list* itself carried real recruiter threads even
though the *selected* detail was a fixture.) The fix used here: a small
static-HTML mockup (`assets/mockup/`) that reproduces the app's exact markup
and CSS (`web/src/styles.css`, `web/src/ReviewQueue.tsx`'s structure) and
renders it against nothing but the 13 fixtures in
`shared/fixtures/emails.ts`, served locally and screenshotted — no live app,
no Cognito session, no DynamoDB, no real data anywhere in the pipeline.

- `assets/final/review-queue-detail.jpg` — three-panel review queue: queue list
  (left), email thread (center), drafted-reply panel with `To Respond / Work /
  P8` classification dropdowns and a 55% confidence badge (right), fixture
  `sarah.chen@example.com`. Reviewer identity is a generic placeholder
  (`reviewer@example.com` / "J. Reviewer") rather than a real account, since
  the real app's drafted-reply sign-off is generated client-side from
  whoever is logged in (`web/src/ReviewQueue.tsx`, `defaultDraftReply()`) —
  the mockup sidesteps that entirely rather than redacting it after the fact.
- `assets/final/review-queue-awaitingreply.jpg` — same layout, different
  fixture (`you@example.com`), classified `Awaiting Reply / Work / P5` — good
  second shot to show a different taxonomy value.
- `assets/mockup/` — `build-data.mjs` (reconstructs the seeded fixture
  records) and `render.mjs` (emits the two static HTML pages) — rerun with
  `node render.mjs` and reload in a browser to recapture or add shots.
- Diagram: build fresh in Remotion (SVG/HTML, not a screenshot) mirroring the
  README's ASCII architecture diagram — see Scene 2 spec below.

No further capture is needed for this cut. If more screenshots are wanted
later (e.g. the correction flow, "Approved"/"Sent" queues), extend
`render.mjs` rather than going back to the live app — the live queue mixes
real inbox threads into the same list with no way to filter them out from
the UI side.

---

## Scene-by-scene

### Scene 1 — Cold open (0:00–0:20)

**Visual:** `review-queue-detail.jpg` and `-awaitingreply.jpg` are 1350×896
captures; the app's content sits in roughly the top half of that frame with
blank page background below — crop to the actual content bounds before
compositing (check exact pixel bounds against the files, don't assume) rather
than stretching the blank space to fill 1080p. Ken Burns push-in starting
wide (full three-panel view) and settling on the drafted-reply panel with its
confidence badge, then cut to `review-queue-awaitingreply.jpg` at ~0:14 (same
crop, quick 0.6s crossfade) to show a second, differently-classified email —
signals "this handles variety," not one canned example.

**Caption/lower-third (appears ~0:03):** `email-concierge — Gmail triage MVP`

**VO script (~20s at natural pace):**
> "This is email-concierge — it polls Gmail, classifies every new message,
> labels it, and drafts a reply for anything that needs one. It creates that
> draft in Gmail; it never sends — sending stays a separate, manual step in
> Gmail itself. What I want to walk you through isn't the UI — it's the AWS
> decisions underneath it."

**Transition:** Hard cut / wipe into Scene 2's diagram, timed to land exactly
as VO says "AWS decisions underneath it."

### Scene 2 — Architecture reel (0:20–2:00), one persistent diagram

**Base diagram (draws in once, ~0:20–0:24, then stays on screen for the rest
of the video):**

```
EventBridge Scheduler ──▶ poll-lambda ──▶ Gmail API
                              │  (heuristic filter first)
                              ▼
                        Jev ──▶ Haiku (fallback)
                              │
                              ▼
                     DynamoDB "emails" table
                              │
                              ▼ (Streams)
                        draft-lambda ──▶ Gmail drafts

Cognito ◀── Amplify Hosting (SPA)
    │
    ▼
API Gateway (HTTP API) ──▶ api-lambda ──▶ DynamoDB (scan + corrections)
                                                │
                                                ▼ (non-fixture corrections only)
                                          Gmail batchModify (sync label back)
```

Render as clean boxes/arrows (AWS-service-shaped icons optional but not
required — plain labeled boxes read fine at this size and avoid a licensing/
asset-sourcing detour tonight). Boxes start at 40% opacity/desaturated; each
beat below brings its 1–2 relevant boxes to full color + a subtle glow/scale
pulse, dims back down when the next beat starts. This is the mechanism that
makes 6 beats feel like one coherent system instead of 6 slides.

Caption style: one-line title (the decision) + one-line "why", bottom-third,
timed to appear as VO states it and clear before the next beat's VO starts.

---

**Beat 1 — Lambda + EventBridge Scheduler, not Fargate (0:24–0:40, ~16s)**

*Highlight:* `EventBridge Scheduler` and `poll-lambda` boxes.

*Caption:* `Lambda + EventBridge Scheduler — not Fargate`
`Bursty workload, zero idle cost`

*VO:*
> "It polls every two minutes, in short bursts — no persistent connection to
> hold open. Lambda's per-invocation billing fits that better than a Fargate
> task sitting ready between polls. EventBridge Scheduler, not the older
> CloudWatch Events rule, gives each schedule its own IAM execution role
> instead of a permission on a shared event bus."

**Beat 2 — DynamoDB, not RDS (0:40–0:56, ~16s)**

*Highlight:* `DynamoDB "emails" table` box, then the Streams arrow to
`draft-lambda`.

*Caption:* `DynamoDB — not RDS`
`Mostly known-key access, Streams decouples drafting`

*VO:*
> "The data model is one item per email, mostly looked up by message ID —
> the review-queue API's one table scan aside, there's no relational join
> anywhere. DynamoDB's on-demand pricing is near-zero at this volume, and its
> Streams feature is what decouples reply drafting from polling — an insert
> triggers draft-lambda directly, instead of the poll loop generating the
> reply itself."

**Beat 3 — HTTP API, not REST API (0:56–1:10, ~14s)**

*Highlight:* `API Gateway (HTTP API)` box and the `Cognito` link into it.

*Caption:* `HTTP API — not REST API`
`Cheaper per request, native JWT auth against Cognito`

*VO:*
> "The review-queue API sits behind API Gateway's HTTP API, not REST API —
> it's meaningfully cheaper per request, and it validates Cognito JWTs
> natively with no separate Lambda authorizer. REST API's extra features —
> request transformation, usage plans — have no use case here."

**Beat 4 — Polling, not Pub/Sub push (1:10–1:24, ~14s)**

*Highlight:* the `poll-lambda ──▶ Gmail API` arrow.

*Caption:* `Polling — not Gmail push notifications`
`Push expires every 7 days; polling needs no extra infra`

*VO:*
> "Gmail does offer push notifications, but the underlying watch subscription
> expires every seven days and has to be renewed, and delivery needs either a
> public HTTPS endpoint or a Pub/Sub subscriber. A two-minute poll costs a
> trivial slice of the daily API quota and needs no extra infrastructure to
> run."

**Beat 5 — Heuristic first, then Jev, then Haiku (1:24–1:40, ~16s)**

*Highlight:* `Jev ──▶ Haiku (fallback)` box pair (a small heuristic-filter tag
on `poll-lambda` itself, ahead of both).

*Caption:* `Heuristic filter → Jev → Haiku fallback`
`Cheapest check first; the LLM is the last resort, not the first`

*VO:*
> "Classification is a cascade, not one LLM call. A cheap heuristic filter
> runs first, no API call needed. What's left goes to Jev, a typed decision
> model answering all three classification questions in one batched call,
> falling back to Claude Haiku only on error or timeout. Haiku alone
> generates the draft text — Jev is deliberately non-generative."

**Beat 6 — "No send, ever" (1:40–1:58, ~18s, closing beat)**

*Highlight:* the whole `Gmail API` box pulses red/amber, then a small padlock
icon overlay on `poll-lambda`/`draft-lambda`.

*Caption:* `"No send, ever" — enforced in code, not OAuth scope`
`gmail.modify technically allows send; there's no narrower scope`

*VO:*
> "Gmail's API has no scope that allows drafting and labeling but blocks
> sending — `gmail.modify` technically permits both. So the boundary is
> enforced in code: one module is the only place allowed to import the Gmail
> client, with a fixed allowlist of methods that leaves `send` out
> completely, policed by tests on every push."

### Scene 3 — Button (1:58–2:00)

**Visual:** Diagram fades to 30% opacity; centered title card fades up.

**Caption:** `email-concierge — Terraform, 3 Lambdas, est. ~$1–2/month`

**VO:** *(none — let the last beat's line land, 2s of silence/breath before
cut)*

---

## Remotion composition notes

- **Structure:** one `<Composition>`, `durationInFrames` = 120s × 30fps = 3600.
  Scene 1 = frames 0–600, Scene 2 = 600–3540, Scene 3 = 3540–3600.
- **Diagram component:** a single `<ArchitectureDiagram highlightKey={beat} />`
  that takes the current beat's key and interpolates box opacity/scale via
  `interpolate()` keyed off `useCurrentFrame()` — not 6 separate diagram
  components. This is what keeps the "persistent diagram" promise real rather
  than 6 diagrams that happen to look similar.
- **Captions:** a small `Caption` component reading a per-beat `{title, sub}`
  from a single script/timing table (see below) — build the whole video's
  timing off one array so VO, captions, and highlight timing can't drift out
  of sync with each other.
- **Audio:** generate the ElevenLabs VO as one continuous file first (not
  per-beat clips), get its actual duration back, then derive each beat's
  frame range from silence-gaps or fixed offsets in the script — don't hand-
  guess beat durations and hope the VO fits, record first, time second.
- **Screenshots:** import `assets/final/review-queue-detail.jpg` and
  `assets/final/review-queue-awaitingreply.jpg` as `<Img>` with a `<Sequence>` +
  spring-based `scale`/`translate` for the Ken Burns push-in — no external Ken
  Burns library needed for a two-shot cold open.

## Script timing table (for the Remotion script + ElevenLabs input)

| # | Start | End | Beat | VO word count (~) |
|---|-------|-----|------|---|
| 0 | 0:00 | 0:20 | Cold open | ~62 words |
| — | 0:20 | 0:24 | Diagram draws in (no VO) | 0 words |
| 1 | 0:24 | 0:40 | Lambda vs Fargate | ~48 words |
| 2 | 0:40 | 0:56 | DynamoDB vs RDS | ~55 words |
| 3 | 0:56 | 1:10 | HTTP API vs REST | ~40 words |
| 4 | 1:10 | 1:24 | Polling vs push | ~48 words |
| 5 | 1:24 | 1:40 | Heuristic → Jev → Haiku cascade | ~52 words |
| 6 | 1:40 | 1:58 | No send, ever | ~52 words |
| 7 | 1:58 | 2:00 | Button | 0 words |

All beats now sit in the ~170–195 wpm range, comfortable for natural
narration — still worth timing against the actual ElevenLabs recording and
adjusting frame ranges to the real audio rather than these estimates.

Full VO script concatenated (feed to ElevenLabs as one generation for
consistent pacing/prosody, then split by silence for per-beat frame timing):

> This is email-concierge — it polls Gmail, classifies every new message,
> labels it, and drafts a reply for anything that needs one. It creates that
> draft in Gmail; it never sends — sending stays a separate, manual step in
> Gmail itself. What I want to walk you through isn't the UI — it's the AWS
> decisions underneath it.
>
> It polls every two minutes, in short bursts — no persistent connection to
> hold open. Lambda's per-invocation billing fits that better than a Fargate
> task sitting ready between polls. EventBridge Scheduler, not the older
> CloudWatch Events rule, gives each schedule its own IAM execution role
> instead of a permission on a shared event bus.
>
> The data model is one item per email, mostly looked up by message ID — the
> review-queue API's one table scan aside, there's no relational join
> anywhere. DynamoDB's on-demand pricing is near-zero at this volume, and its
> Streams feature is what decouples reply drafting from polling — an insert
> triggers draft-lambda directly, instead of the poll loop generating the
> reply itself.
>
> The review-queue API sits behind API Gateway's HTTP API, not REST API —
> it's meaningfully cheaper per request, and it validates Cognito JWTs
> natively with no separate Lambda authorizer. REST API's extra features —
> request transformation, usage plans — have no use case here.
>
> Gmail does offer push notifications, but the underlying watch subscription
> expires every seven days and has to be renewed, and delivery needs either a
> public HTTPS endpoint or a Pub/Sub subscriber. A two-minute poll costs a
> trivial slice of the daily API quota and needs no extra infrastructure to
> run.
>
> Classification is a cascade, not one LLM call. A cheap heuristic filter
> runs first, no API call needed. What's left goes to Jev, a typed decision
> model answering all three classification questions in one batched call,
> falling back to Claude Haiku only on error or timeout. Haiku alone
> generates the draft text — Jev is deliberately non-generative.
>
> Gmail's API has no scope that allows drafting and labeling but blocks
> sending — gmail dot modify technically permits both. So the boundary is
> enforced in code: one module is the only place allowed to import the Gmail
> client, with a fixed allowlist of methods that leaves send out completely,
> policed by tests on every push.

---

## What was deliberately cut (and why)

Per the grilling session, these README ADRs did **not** get a dedicated beat
— 2 minutes only fits 6 architecture beats at a pace an interviewer can
actually follow:

- **Terraform, not CDK** — tooling preference more than an AWS-service
  trade-off; weaker signal for an FDE-specific evaluation.
- **Amplify manual deploy, not GitHub-connected** — a workaround for a PAT
  access constraint, not a reusable architectural pattern.
- **Secrets Manager, not SSM Parameter Store** — narrow (one secret), lower
  illustrative value than the other 6.
- **"Not agentic, by design"** — an important scope decision but abstract to
  visualize in a 2-minute reel; not mentioned at all rather than rushed.

If there's time to extend the video later (e.g. a 3–4 minute version for a
portfolio site rather than tomorrow's interview), these are the natural next
beats to add, in that order.
