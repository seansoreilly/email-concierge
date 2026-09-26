# Gmail triage agent: architecture options

This is the ideation doc — it takes the two research threads in this repo (`reports/Gmail LLM triage design.md`
for general Gmail/LLM triage methods, and the Jev/eve findings below) and turns them into concrete build options.

## What "Jev AI" turned out to be (verified, not a guess)

Confirmed directly against npm, PyPI, GitHub, and Vercel's own docs — not taken on a subagent's word:

- **Jev** is a real, very new (public since 2026-09-15) classification model from **TypeSafe AI**, a startup
  founded by Diogo Almeida (ex-OpenAI, worked on InstructGPT/ChatGPT/GPT-4 RLHF). It's deliberately **not** a
  chatbot/LLM — it's a fast, cheap "System One" decision model. You give it a block of state plus one or more
  typed questions, and it returns calibrated answers with per-option probabilities:
  - `Choice` — pick 1 of up to 255 labeled options
  - `Score` — a position on an ordinal 2–10 point scale
  - `Noul` — a yes/no with a probability (0–1)
  - Reported latency 70–500ms, and 40–200x cheaper/faster than frontier LLMs on this class of task.
  - Pricing: $0.042 / M input tokens, output free (per TypeSafe's own docs/dev.to walkthrough).
  - SDKs are real, published packages: `@typesafe-ai/sdk` (npm, v0.6.0) and `typesafe-sdk` (PyPI, v0.7.1),
    both maintained by `@typesafe.ai` addresses, both pointing to `docs.typesafe.ai` and
    `github.com/typesafe-ai/*`.
  - Also reachable through **Vercel AI Gateway** as the model string `typesafe-ai/jev`.
- **eve** (`eve.dev`, docs also mirrored at `vercel.com/docs/eve`) is Vercel's open-source, filesystem-first
  framework for durable backend AI agents — currently **Beta**. Scaffold with `npx eve@latest init my-agent`.
  An agent project is just files under `agent/`: `instructions.md`, `agent.ts` (`defineAgent`), one file per
  tool under `tools/*.ts` (`defineTool`), plus `skills/`, `subagents/`, `channels/`, `connections/`,
  `sandbox/`. Sessions are durable (built on Vercel Workflows — survive cold starts/redeploys), and every
  run gets automatic tracing in the Vercel dashboard ("Agent Runs").
- **The two are explicitly linked** — this is the strongest evidence they're one intended stack, not two
  competing guesses at what the user meant. eve's own docs ship a guide, *"Automatically approve tool calls
  with Jev"* (`vercel.com/kb/guide/auto-approve-tool-calls-eve-jev`), confirmed by direct fetch:
  ```ts
  // agent/lib/command-approval.ts
  import { auto } from 'eve/tools/approval';
  export function commandApproval(model = 'typesafe-ai/jev') {
    return auto({ model, instructions: '...', criteria: { clear: '...', caution: '...' } });
  }
  // agent/tools/bash.ts
  export default defineTool({ ...bash, approval: commandApproval() });
  ```
  Calls classified `clear` run without a human prompt; `caution` calls pause until a person approves/rejects.
  This is a direct, reusable pattern for a triage agent's mutating actions (archive/label/delete/send).
- **Gmail access**: Vercel Connect's Google connector (`vercel connect create google`) explicitly lists
  "Google APIs - Gmail, Drive, Calendar, Sheets, YouTube, and more," confirmed by direct fetch of
  `vercel.com/connect/google`. It manages the OAuth code flow and token storage server-side — your code
  calls `getToken('google/<connection-name>')` and never touches refresh tokens directly. **Not verified**:
  whether Vercel Connect handles Google's *restricted-scope verification/CASA* requirement for you, or
  leaves that to you — confirm this directly before committing to it for `gmail.readonly`/`gmail.modify`.
- **Gaps flagged honestly, not papered over**: no documented Gmail Pub/Sub push channel ships with eve —
  you'd write a custom `agent/channels/gmail-push.ts` to receive Gmail's push webhook (this is architecturally
  straightforward given eve's channel pattern, but there's no worked example in the docs). Polling via a
  `defineSchedule` cron is the documented, zero-DIY path.

## What the general Gmail/LLM triage research found (see `Gmail LLM triage design.md` for full detail + sources)

Headline conclusions, condensed:

- **Gmail REST API, not IMAP.** Reading mail content always touches a Google *restricted* OAuth scope
  (`gmail.readonly`/`gmail.modify`/`gmail.metadata`), but Google explicitly exempts apps used only by people
  personally known to the developer from formal verification — i.e. this project's situation. The real
  friction is the 7-day refresh-token expiry for apps left in OAuth "Testing" status; flipping the consent
  screen to "In production" (while staying unverified) is the well-corroborated workaround.
- **Poll `history.list`, don't bother with Pub/Sub push**, at single-mailbox scale. Push notifications expire
  every 7 days and need renewal, need a public HTTPS endpoint or a Pub/Sub subscriber, and quota isn't the
  constraint here — polling every 1–5 minutes costs a trivial fraction of the daily quota.
- **Classification cascade**: free header/sender heuristics first (List-Unsubscribe, Precedence: bulk, sender
  domain, Gmail's own CATEGORY_* labels) → structured-output LLM call (or Jev `Choice`/`Score`/`Noul`) for
  everything else → review bucket sized to what you'll actually look at daily, gated on *empirical* per-category
  precision from logged corrections, not the model's self-reported confidence (which is well-documented as
  miscalibrated).
- **Taxonomy**: converges on a small mutually-exclusive response-state field (To Respond / Awaiting Reply /
  FYI / Done) + an orthogonal content-type tag + a separate priority score — not one flat category list.
  Category counts in real products cluster around 5–8.
- **Feedback loop**: versioned natural-language rule edits (a correction proposes a diff to that category's
  criteria text) beat full retraining at personal scale; per-sender memory as a simple lookup table
  (SaneBox-style) short-circuits repeat senders before the model even runs.
- **Safety is the single most load-bearing decision**: every real 2024–2025 prompt-injection incident found
  in the research (EmailGPT/CVE-2024-5184, EchoLeak, ShadowLeak, the Gemini-in-Gmail phishing bug) required
  an *exfiltration channel* — send, reply, or arbitrary fetch — on top of untrusted content + private-data
  access ("lethal trifecta"). **A read+label-only agent with no send capability removes that third leg almost
  entirely.** Enforce outputs against a code-side label allowlist; treat prompt fencing as defense-in-depth,
  not the primary control.
- **Cost is a non-issue** at personal-inbox volume — worst case roughly $1.50–2.60 per 1,000 emails
  unoptimized on a small frontier model, dropping toward cents per 1,000 with caching/batching. Jev, if used
  for the classification step, is cheaper still by design.

## Three concrete architecture options

### Option A — eve + Jev + Vercel Connect (the "native stack")
Use eve as the agent shell, Jev for the actual per-email classification (`Choice` for category,
`Score` for priority, `Noul` for "needs a reply?"), Vercel Connect's Google connector for Gmail OAuth, and
eve's `commandApproval`/Jev-gated pattern for any mutating action (apply label, archive, draft).
- **Pros**: everything traced/observable for free (Agent Runs), HITL approval is a first-class pattern not
  something you build yourself, Jev is purpose-built for exactly this classification shape and is very cheap.
- **Cons/risks**: eve is Beta (APIs may change), you're betting on a brand-new vendor (TypeSafe AI, 2 weeks
  old) for the core classification call, no documented Gmail push-webhook channel (would need to DIY or just
  poll on a schedule), and the restricted-scope/CASA question for Vercel Connect + Gmail isn't spelled out in
  the docs — needs a direct spike.
- **Best if**: you want to build on Vercel anyway, you like the idea of typed/deterministic classification
  over LLM-prose-parsing, and you're comfortable being an early adopter of both eve and Jev.

### Option B — Plain Gmail API + small-model cascade, self-hosted (the "boring, proven" stack)
Skip eve/Jev entirely. A scheduled job (cron, GitHub Action, or a simple server) polls `history.list`,
runs the rules → structured-output-LLM cascade described above (Claude Haiku 4.5 or Gemini Flash-Lite are
both cheap and good fits), applies labels via `batchModify`, and stops there — no send capability at all.
- **Pros**: no dependency on brand-new vendors, well-trodden path (this is what Inbox Zero and the
  `dmarchevsky/gmail-triage` project already do), full control over data handling/retention.
- **Cons**: you build the HITL/approval and observability pieces yourself; no free typed-decision primitive
  as cheap as Jev claims to be.
- **Best if**: you want something you can fully reason about and that doesn't depend on two brand-new
  products landing well.

### Option C — Hybrid: Option B's plumbing, Jev as the classification engine
Keep your own polling/label-application code (Option B), but call Jev directly via its SDK/API (or through
Vercel AI Gateway, `typesafe-ai/jev`, if you're already using the Gateway) for the classification step only —
skip eve. Use a normal LLM only when Jev's confidence is low or when you need to draft a reply.
- **Pros**: gets Jev's speed/cost benefit without committing to eve-as-Beta-framework; simplest to reason
  about; matches the research's own cascade recommendation (cheap/fast first, LLM only when needed) almost
  exactly, with Jev slotted in as the "cheap/fast" tier instead of a distilled/small LLM.
- **Cons**: still an early dependency on TypeSafe AI's uptime/pricing stability; loses eve's free
  observability and built-in approval pattern, so you'd hand-roll HITL for any mutating action.
- **Best if**: you want to try Jev's actual value proposition (typed, cheap classification) without betting
  the whole app on a Beta agent framework at the same time.

## My read

Given this is a personal, single-mailbox tool — not something that needs to scale — **Option C** is the
strongest starting point: it isolates the one genuinely novel, differentiated idea here (Jev's typed
classification is a good structural fit for triage, and it's cheap enough that cost is a non-issue either
way) from the one genuinely risky dependency (eve as a Beta framework you'd otherwise have no reason to
adopt for a single-mailbox tool). You can always fold eve in later if the observability/approval scaffolding
turns out to be worth it once the classification logic is proven out. Option A is worth revisiting once
eve/Jev have a few more months of track record, or if you're already building other things on Vercel/eve
where the shared infrastructure pays for itself.

Either way, the non-negotiables from the safety research should hold regardless of which option you pick:
no send scope, ever; validate every classification output against a code-side label allowlist; log
corrections with message IDs/hashes rather than full bodies; and treat any instruction-shaped text found
inside an email body as data, never as something the agent should act on.

## Open questions to resolve before building (from both research threads)

1. Does Vercel Connect's Google connector handle Google's restricted-scope verification/CASA requirement,
   or is that still on you? (Unverified in the docs fetched.)
2. Is "In production + unverified" on the Google OAuth consent screen a durable, sanctioned state for
   refresh-token lifetime, or a community workaround that could break? Build defensive re-auth handling
   either way.
3. How much do you actually want auto-drafted replies vs. pure labeling/sorting? That decision alone moves
   you from "read-only, very low risk" to "needs a send-adjacent capability, much higher scrutiny."
4. Do you want real-time-ish triage (worth the push/webhook complexity) or is a 1–5 minute polling delay
   totally fine for how you use email? The research suggests polling is fine at this scale.

## Sources

Jev/eve claims were verified directly against: `npm view @typesafe-ai/sdk`, the PyPI JSON API for
`typesafe-sdk`, `github.com/fazlerocks/jevmail`'s README, and direct fetches of `vercel.com/docs/eve`,
`vercel.com/kb/guide/auto-approve-tool-calls-eve-jev`, `vercel.com/connect/google`, and
`docs.typesafe.ai/sdk/javascript` — not taken on a single subagent's unverified word. Full source list and
caveats for the general Gmail/LLM triage findings are inline in `Gmail LLM triage design.md` and the
per-topic notes under `research_notes/Gmail LLM triage design/`.
