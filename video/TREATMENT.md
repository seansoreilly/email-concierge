# email-concierge — 2-minute explainer video treatment

**Purpose:** AWS Forward Deployed Engineer interview reel. Audience is a technical
evaluator, not an end user — the video's job is to demonstrate AWS
solutions-architecture judgment, using the working UI as proof-of-life, not as
the main event.

**Runtime:** ~120s. **Format:** Remotion composition, 1920x1080, 30fps.
**Narration:** ElevenLabs TTS, "Jess" voice, one continuous VO track, captions
burned in and synced to VO timing.

**Structure:** 20s cold-open UI proof → 100s architecture-decision reel (6 beats,
~16–17s each) over one persistent, animated system diagram.

---

## Asset inventory

- `assets/final/review-queue-detail.jpg` — three-panel review queue: queue list
  (left), email thread (center), drafted-reply panel with `To Respond / Work /
  P8` classification dropdowns and a 55% confidence badge (right), fixture
  `sarah.chen@example.com`. Captured live against the deployed Amplify app,
  logged in via the real Cognito session, using synthetic fixture data
  (`pnpm seed`) — all 13 fixtures use fictional senders, no real inbox content
  anywhere. One real element still had to be redacted: the drafted-reply
  panel's sign-off is generated client-side from the *logged-in Cognito
  user's* identity (`web/src/ReviewQueue.tsx`, `defaultDraftReply()`), not
  from the database — it shows the real account regardless of which fixture
  is selected. That line, and the reviewer-avatar corner (bottom-left), are
  redacted (black bars) in both shots.
- `assets/final/review-queue-awaitingreply.jpg` — same layout, different
  fixture (`you@example.com`), classified `Awaiting Reply / Work / P5` — good
  second shot to show a different taxonomy value.
- `assets/raw/` — unredacted originals, kept for reference only. **Never use
  these directly in the video** — they contain the real sign-off email and
  reviewer account name. Always render from `assets/final/`.
- Diagram: build fresh in Remotion (SVG/HTML, not a screenshot) mirroring the
  README's ASCII architecture diagram — see Scene 2 spec below.

No further live capture is needed. If more screenshots are wanted later (e.g.
the correction flow, "Approved"/"Sent" queues), reseed fixtures with `pnpm
seed` and recapture the same way — never screenshot the live queue without
seeding fixtures first, since real inbox threads are mixed into the same
DynamoDB table and are easy to click into by accident.

---

## Scene-by-scene

### Scene 1 — Cold open (0:00–0:20)

**Visual:** Full-bleed `review-queue-detail.jpg`, slow Ken Burns push-in
starting wide (full three-panel view) and settling on the drafted-reply panel
with its confidence badge. Cut to `review-queue-awaitingreply.jpg` at ~0:14 (quick
0.6s crossfade) to show a second, differently-classified email — signals
"this handles variety," not one canned example.

**Caption/lower-third (appears ~0:03):** `email-concierge — Gmail triage MVP`

**VO script (~20s at natural pace):**
> "This is email-concierge — it polls Gmail, classifies every new message,
> labels it, and drafts a reply for anything that needs one. Nothing sends
> without a human approving it. What I want to walk you through isn't the UI —
> it's the AWS decisions underneath it."

**Transition:** Hard cut / wipe into Scene 2's diagram, timed to land exactly
as VO says "AWS decisions underneath it."

### Scene 2 — Architecture reel (0:20–2:00), one persistent diagram

**Base diagram (draws in once, ~0:20–0:24, then stays on screen for the rest
of the video):**

```
EventBridge Scheduler ──▶ poll-lambda ──▶ Gmail API
                              │
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
API Gateway (HTTP API) ──▶ api-lambda ──▶ DynamoDB
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
> "It polls every two minutes and does a burst of work — no long-lived
> process, no persistent connection. That's a Lambda shape, not a Fargate
> shape — Fargate would sit idle between polls and bill for it. EventBridge
> Scheduler, not the older CloudWatch Events rule, because it's AWS's current
> direction, and it gives each schedule its own IAM execution role instead of
> sharing one event bus."

**Beat 2 — DynamoDB, not RDS (0:40–0:56, ~16s)**

*Highlight:* `DynamoDB "emails" table` box, then the Streams arrow to
`draft-lambda`.

*Caption:* `DynamoDB — not RDS`
`No joins, known-key access, Streams decouples drafting`

*VO:*
> "The data model is one item per email, looked up by message ID — no
> relational joins. DynamoDB's on-demand pricing is near-zero at this volume,
> and its Streams feature is what lets draft generation happen
> asynchronously — an insert triggers draft-lambda directly, so the poll loop
> never waits on Anthropic's API."

**Beat 3 — HTTP API, not REST API (0:56–1:10, ~14s)**

*Highlight:* `API Gateway (HTTP API)` box and the `Cognito` link into it.

*Caption:* `HTTP API — not REST API`
`~1/5th the cost, native JWT auth against Cognito`

*VO:*
> "The review-queue API sits behind API Gateway's HTTP API, not REST API —
> about a fifth of the per-request cost, and it validates Cognito JWTs
> natively. REST API's extra features — request transformation, usage plans —
> have no use case here."

**Beat 4 — Polling, not Pub/Sub push (1:10–1:24, ~14s)**

*Highlight:* the `poll-lambda ──▶ Gmail API` arrow.

*Caption:* `Polling — not Gmail push notifications`
`Push expires every 7 days; polling needs no extra infra`

*VO:*
> "Gmail does offer push notifications, but they expire weekly and need a
> public endpoint or a Pub/Sub subscriber to renew. A two-minute poll costs a
> trivial slice of the API quota and needs nothing extra to run."

**Beat 5 — Jev primary, Haiku fallback (1:24–1:40, ~16s)**

*Highlight:* `Jev ──▶ Haiku (fallback)` box pair.

*Caption:* `Jev primary, Claude Haiku fallback`
`Typed decision model first — ~12x cheaper, ~10x faster`

*VO:*
> "Classification isn't one LLM call — it's a typed decision model, Jev,
> answering three questions in a single batched call, falling back to Claude
> Haiku only if Jev errors or times out. Haiku's also the only model that
> generates the draft text — Jev is deliberately non-generative, so it
> structurally can't do that job."

**Beat 6 — "No send, ever" (1:40–1:58, ~18s, closing beat)**

*Highlight:* the whole `Gmail API` box pulses red/amber, then a small padlock
icon overlay on `poll-lambda`/`draft-lambda`.

*Caption:* `"No send, ever" — enforced in code, not OAuth scope`
`gmail.modify technically allows send; there's no narrower scope`

*VO:*
> "Gmail's API has no scope that allows drafting and labeling but blocks
> sending — `gmail.modify` technically permits both. So the boundary is
> enforced in code: one module is the only place allowed to import the Gmail
> client, it exposes a fixed allowlist of nine methods with `send` absent
> from it, and two CI tests police that boundary by static analysis on every
> push."

### Scene 3 — Button (1:58–2:00)

**Visual:** Diagram fades to 30% opacity; centered title card fades up.

**Caption:** `email-concierge — Terraform, 3 Lambdas, ~$1–2/month`

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
| 0 | 0:00 | 0:20 | Cold open | ~45 words |
| 1 | 0:20 | 0:40 | Lambda vs Fargate | ~55 words |
| 2 | 0:40 | 0:56 | DynamoDB vs RDS | ~50 words |
| 3 | 0:56 | 1:10 | HTTP API vs REST | ~40 words |
| 4 | 1:10 | 1:24 | Polling vs push | ~42 words |
| 5 | 1:24 | 1:40 | Jev + Haiku cascade | ~55 words |
| 6 | 1:40 | 1:58 | No send, ever | ~60 words |
| 7 | 1:58 | 2:00 | Button | 0 words |

Full VO script concatenated (feed to ElevenLabs as one generation for
consistent pacing/prosody, then split by silence for per-beat frame timing):

> This is email-concierge — it polls Gmail, classifies every new message,
> labels it, and drafts a reply for anything that needs one. Nothing sends
> without a human approving it. What I want to walk you through isn't the
> UI — it's the AWS decisions underneath it.
>
> It polls every two minutes and does a burst of work — no long-lived
> process, no persistent connection. That's a Lambda shape, not a Fargate
> shape — Fargate would sit idle between polls and bill for it. EventBridge
> Scheduler, not the older CloudWatch Events rule, because it's AWS's current
> direction, and it gives each schedule its own IAM execution role instead of
> sharing one event bus.
>
> The data model is one item per email, looked up by message ID — no
> relational joins. DynamoDB's on-demand pricing is near-zero at this volume,
> and its Streams feature is what lets draft generation happen
> asynchronously — an insert triggers draft-lambda directly, so the poll loop
> never waits on Anthropic's API.
>
> The review-queue API sits behind API Gateway's HTTP API, not REST API —
> about a fifth of the per-request cost, and it validates Cognito JWTs
> natively. REST API's extra features — request transformation, usage
> plans — have no use case here.
>
> Gmail does offer push notifications, but they expire weekly and need a
> public endpoint or a Pub/Sub subscriber to renew. A two-minute poll costs a
> trivial slice of the API quota and needs nothing extra to run.
>
> Classification isn't one LLM call — it's a typed decision model, Jev,
> answering three questions in a single batched call, falling back to Claude
> Haiku only if Jev errors or times out. Haiku's also the only model that
> generates the draft text — Jev is deliberately non-generative, so it
> structurally can't do that job.
>
> Gmail's API has no scope that allows drafting and labeling but blocks
> sending — gmail dot modify technically permits both. So the boundary is
> enforced in code: one module is the only place allowed to import the Gmail
> client, it exposes a fixed allowlist of nine methods with send absent from
> it, and two CI tests police that boundary by static analysis on every push.

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
