# email-concierge

A Gmail triage MVP: polls an inbox, classifies each new message with a typed decision model
(Jev, primary) and an LLM fallback (Claude Haiku), applies Gmail labels, and drafts replies
(never sent) for messages that need a response. A Cognito-gated review-queue web UI shows every
classification and lets a human correct it.

This is a demo built to show AWS solutions-architecture judgment — service choices, tradeoffs,
and cost — not a production tool. Every non-obvious decision below has a reason attached.

**Live**: `https://mvp.d2sqaqo48s97lx.amplifyapp.com` (Cognito login required — see
[Credentials recap](#credentials-recap)). Live Gmail polling and draft generation are connected
and running — see [Finishing setup](#finishing-setup-the-one-step-only-you-can-do) for how, and
for the runbook if the refresh token ever needs to be re-issued.

## Architecture

```
EventBridge Scheduler (2 min) → poll-lambda → Gmail API (history.list / messages.list)
                                      │              │
                                      │              ▼
                                      │        Jev (OpenRouter) → Haiku (fallback)
                                      │              │
                                      ▼              ▼
                              DynamoDB "emails" table (classification + full email)
                                      │
                                      ▼ (Streams, filtered: INSERT + responseState="To Respond")
                                draft-lambda → Haiku (draft body) → Gmail drafts.create

Cognito (SPA client, SRP auth) ← Amplify Hosting (static SPA, manual deploy)
        │
        ▼
API Gateway (HTTP API, JWT authorizer) → api-lambda → DynamoDB (list + corrections)
                                                │
                                                ▼ (non-fixture corrections only)
                                          Gmail batchModify (sync label back)
```

Three Lambdas, one DynamoDB table for state, one for a sync cursor, one Secrets Manager secret
for the Gmail OAuth refresh token, one Cognito pool with a single admin-created user.

## Is / is not

**Is**: read-and-label Gmail integration, draft generation gated behind a human sending it,
a review queue sorted by classifier confidence so uncertain calls surface first, corrections
that sync back to Gmail and are logged for later analysis, fully Terraform-defined
infrastructure, demoable from synthetic fixtures with no live Gmail connection required.

**Is not**: capable of sending mail under any configuration (see
[Safety invariant](#safety-invariant-no-send-ever)), capable of archiving/trashing/deleting
mail, multi-user, agentic (see [ADR: not agentic](#adr-not-agentic-by-design)), reconciled
against out-of-band Gmail-side changes (a human editing/deleting a generated draft directly in
Gmail, or replying before a draft is generated, isn't detected), backed by a live-model
evaluation harness (CI runs against fixtures with mocked network boundaries; there's no ongoing
measurement of Jev/Haiku's real-world classification accuracy).

## ADRs

Each of these was a fork the build could have taken differently; here's why it went this way.

**Terraform, not CDK.** All infrastructure — including `aws_amplify_app` — is plain Terraform,
not CDK or Amplify Gen 2's CDK-native constructs. Terraform's state model and plan/apply cycle
are provider-agnostic and don't require buying into a specific SDK's abstraction layer; for a
project this size, the extra indirection CDK adds isn't earning its keep.

**Amplify Hosting, manual deploy — not GitHub-connected.** The plan originally called for a
GitHub-connected `aws_amplify_app`. The only GitHub PATs available locally either predate this
repo (verified: a request to `repos/seansoreilly/email-concierge` with the fine-grained token
returned 401) or are broad classic tokens this project's own security posture rules out wiring
into a Terraform variable for a repo connection. `aws_amplify_app` works fine as a deploy target
with no `repository` argument — `scripts/deploy-web.sh` builds the SPA locally and pushes it via
Amplify's manual-deployment API (`create-deployment` → upload zip → `start-deployment`).
GitHub-connected CI/CD is a clean fast-follow once a repo-scoped fine-grained PAT exists.

**HTTP API, not REST API.** API Gateway's newer HTTP API is cheaper (about a fifth of REST API's
per-request cost) and has native JWT authorizer support against a Cognito user pool — no Lambda
authorizer needed. REST API's extra features (request/response transformation, usage plans) have
no use case here.

**Lambda + EventBridge Scheduler, not Fargate.** The workload is bursty (a poll every 2 minutes,
a classification call per new email) with no need for a long-lived process or a persistent
connection. Lambda's per-invocation billing and zero idle cost fit that shape; a Fargate task
would sit mostly idle. EventBridge **Scheduler** (not the legacy CloudWatch Events/EventBridge
rule) was chosen deliberately — it's the current AWS direction for recurring invokes, has a
clearer one-shot-vs-recurring model, and uses its own IAM execution role per schedule rather than
a resource-based Lambda permission tied to a shared event bus.

**DynamoDB, not RDS.** The data model is a single-item-per-email table with no relational joins,
accessed by a known key (`messageId`) or scanned in full at MVP scale (tens to low-hundreds of
items). DynamoDB's on-demand billing means near-zero cost at this volume, and its Streams feature
is what decouples draft generation from the poll loop — an RDS instance would add a persistent
idle cost and buys nothing this schema needs.

**Secrets Manager, not SSM Parameter Store.** Used narrowly: only the Gmail OAuth refresh token,
which is the one credential where rotation/versioning matters (a compromised token needs to be
revocable without a code change) and where the ~$0.40/month cost is trivial. Anthropic/OpenRouter
API keys are passed as Lambda environment variables instead — acceptable for MVP since they're
not tied to a specific human's account access the way an OAuth token is, and it avoids a second
Secrets Manager secret's fixed monthly cost for no real security benefit at this stage.

**Jev primary, Haiku fallback — not LLM-only classification.** Jev (TypeSafe AI's typed decision
model, reached via OpenRouter's `typesafe/jev-1.13`) returns calibrated per-option probabilities
for exactly the three questions this app needs (response-state, content-tag, priority) at a
fraction of an LLM's latency and cost, with all three questions batched into one call per email
(TypeSafe's own benchmark: ~12x cheaper, ~10x faster than one-question-per-call). Claude Haiku
4.5 is the fallback — used only when Jev errors or times out, so a TypeSafe AI outage doesn't
kill classification, and reused for draft generation (a task Jev structurally can't do — it's
non-generative by design).

**Polling, not Pub/Sub push.** Gmail push notifications expire every 7 days and need renewal,
require either a public HTTPS endpoint or a Pub/Sub subscriber, and the Gmail API quota isn't
remotely the constraint at this scale. A 2-minute poll costs a trivial fraction of the daily
quota and needs no additional infrastructure.

**"No send, ever" is enforced in code, not by OAuth scope.** `gmail.modify` — the scope needed
for both label writes and draft creation — also technically permits `messages.send`; there is no
narrower Gmail OAuth scope that allows one but not the other. So the boundary is enforced in
`services/gmail-client/`, the only module in the repo permitted to import `googleapis`:
- It exposes a fixed allowlist of nine Gmail API methods; `messages.send`/`drafts.send` are
  deliberately absent, with no generic passthrough that could reach them.
- `batchModify` additionally validates every label ID against an allowlist of labels this app
  created (the `Concierge/` namespace), so even a bug in the wrapper can't touch an arbitrary
  Gmail label like `TRASH`.
- Drafts always require a `threadId` — there is no code path that produces a standalone,
  unlinked draft.
- Two CI tests reduce (not prove) the risk of an accidental send path: `googleapis` is imported
  only inside `services/gmail-client/`, and a grep scoped to that directory alone finds no
  `messages.send`/`drafts.send` call. (A repo-wide grep for `.send(` would be the wrong test —
  AWS SDK v3 calls every service via `client.send(new XCommand())`, so it would false-positive
  on every DynamoDB or Secrets Manager call elsewhere in the codebase.)

## ADR: not agentic, by design

This is a fixed pipeline — poll → classify → label → conditionally draft — not an agent
framework. Jev is explicitly non-generative: it's a fast typed decision model, the opposite of a
reasoning loop. Haiku is called for exactly two single-shot tasks (classification, draft
generation), never with tool access or multi-step planning. The one place genuinely autonomous
action happens is the DynamoDB Streams trigger, where the system decides to generate a draft with
no human in the loop for that specific step — a real example of event-driven autonomy, but that's
an architecture pattern (decoupled, asynchronous, event-sourced), not an agent-harness pattern.
This was a deliberate scope decision, not an oversight: triage at this shape doesn't need an
agent loop, and building one in would have added complexity without a corresponding problem it
solves.

## Repo layout

```
infra/          Terraform — single state (S3 backend, native lockfile), single apply
services/
  gmail-client/  thin Gmail API wrapper — see "No send, ever" above
  classifier/    Classifier interface: JevClassifier (primary), HaikuClassifier (fallback)
  poll-lambda/   EventBridge Scheduler target — polls, classifies, labels
  draft-lambda/  DynamoDB Streams target — generates and creates draft replies
  api-lambda/    API Gateway target — serves the review queue, handles corrections
shared/
  types.ts       Zod schemas: the taxonomy, EmailRecord, CorrectionRecord
  fixtures/      13 synthetic emails covering every taxonomy value, for tests and demo seeding
web/             Vite + React + TS SPA — Cognito login, review queue, correction UI
scripts/
  seed-fixtures.ts    loads shared/fixtures/ into DynamoDB for a live-data-free demo
  oauth-bootstrap.ts  one-time local script: Gmail OAuth consent → Secrets Manager
  deploy-web.sh       manual Amplify deployment (build → zip → upload → start-deployment)
```

**Reproducing the demo on a fresh clone**: the live table is already seeded, but `pnpm seed`
(reads `EMAILS_TABLE_NAME`, defaults to the live table name) loads the 13 fixtures into DynamoDB
so the review queue isn't empty — no live Gmail connection required for this step.

## Finishing setup (the one step only you can do)

**Status: done.** Live Gmail access requires OAuth credentials granted under your own Google
account — the one step no agent can complete unattended, since it ends in you clicking "Allow"
on Google's consent screen. That grant happened during this build (via an OAuth Client ID
already provisioned in a personal GCP project, reused rather than creating a new one) and the
resulting refresh token is stored in Secrets Manager. `poll-lambda` is backfilling and
classifying real inbox mail, and `draft-lambda` has created its first real Gmail drafts for
"To Respond" messages — confirmed via CloudWatch logs and a DynamoDB scan showing non-fixture
records with `source: "jev"` and `draftCreated: true`.

The steps below are the runbook for re-doing this from scratch — e.g. on a fresh clone, a
different Google account, or if the refresh token is ever revoked (Google can invalidate a
refresh token after ~6 months of inactivity, or immediately if the OAuth consent screen's
publishing status is "Testing" rather than "In production").

1. **Google Cloud Console** (console.cloud.google.com), in a project of your choice:
   - **APIs & Services → Library**: enable the **Gmail API**.
   - **APIs & Services → OAuth consent screen**: choose **External**, add the scope
     `https://www.googleapis.com/auth/gmail.modify`, and set the publishing status to
     **In production** (staying unverified is fine — this app is used only by you — but
     "Testing" status expires refresh tokens every 7 days, which "In production" avoids).
   - **APIs & Services → Credentials → Create Credentials → OAuth Client ID**, application type
     **Desktop app**. Note the Client ID and Client Secret. (Any existing "Desktop app" OAuth
     client already authorized for the Gmail API under your account works too — a new one
     isn't required just for this app.)

2. **Run the bootstrap script locally** (not on AWS — this needs your browser for the consent
   screen):
   ```bash
   GOOGLE_CLIENT_ID=<your client id> \
   GOOGLE_CLIENT_SECRET=<your client secret> \
   GMAIL_OAUTH_SECRET_ARN=arn:aws:secretsmanager:us-east-1:151444831552:secret:email-concierge/gmail-oauth-4U522R \
   pnpm --filter @email-concierge/scripts oauth-bootstrap
   ```
   It prints a consent URL — open it, approve access, and the script stores the resulting
   refresh token in Secrets Manager. Nothing sensitive is printed to your terminal.

3. **Wait for the next poll cycle** (≤2 minutes) or invoke it manually to confirm:
   ```bash
   aws lambda invoke --function-name email-concierge-poll-lambda /tmp/out.json && cat /tmp/out.json
   ```
   On the first run it backfills the last 7 days of inbox mail (capped at 20 messages per
   invocation, draining across subsequent poll cycles if there's a backlog), classifying and
   labeling each one, and creating `Concierge/Status/*` and `Concierge/Tag/*` labels in Gmail on
   first use. "To Respond" emails will get a draft reply within the same or a following cycle.

## Credentials recap

- **Web UI login**: `seansoreilly@gmail.com`. A permanent password was set during this build for
  verification and rotated a few times in the process — treat any password shared in chat during
  setup as temporary and rotate it immediately after your first successful login:
  ```bash
  aws cognito-idp admin-set-user-password \
    --user-pool-id us-east-1_W5xKyfEfo --username seansoreilly@gmail.com \
    --password '<new password, 12+ chars, upper/lower/digit/symbol>' --permanent
  ```
- **Deploying the SPA after a change**: `pnpm --filter web build` is handled automatically by
  `scripts/deploy-web.sh`, which reads Terraform outputs, builds, and pushes to Amplify.
- **`infra/terraform.tfvars`**: not committed (gitignored) — see `infra/terraform.tfvars.example`
  for the shape. Contains the Cognito user's email and the Anthropic/OpenRouter API keys as
  Terraform-sensitive variables.

## Cost (rough, at personal-inbox / demo volume)

| Service | Monthly cost |
|---|---|
| Lambda (3 functions, low invocation volume) | ~$0 (free tier covers this easily) |
| EventBridge Scheduler | ~$0 (free tier: 14M invocations/month) |
| DynamoDB (on-demand, tens–hundreds of items) | ~$0 (free tier: 25 GB storage, 200M requests) |
| API Gateway (HTTP API) | ~$0–1 (free tier: 1M requests/month for 12 months, then $1/M) |
| Secrets Manager (1 secret) | ~$0.40 |
| Cognito (1 user) | $0 (free tier: 10,000 MAUs) |
| Amplify Hosting (static SPA, low traffic) | ~$0–1 (free tier: 15 GB served/month) |
| CloudWatch (logs, 1 alarm) | ~$0 (free tier: 10 alarms, 5 GB logs) |
| Jev via OpenRouter | ~$0.05/M input tokens, effectively free at demo volume |
| Claude Haiku (fallback + draft generation) | a few cents/month at this volume |
| **Total** | **roughly $1–2/month**, dominated by Secrets Manager's fixed cost |

At meaningfully higher volume (thousands of emails/day), the main cost drivers would shift to
Lambda invocation count and classifier API calls — still on the order of a few dollars/month per
the original research's cost analysis (~$1.50–2.60 per 1,000 emails unoptimized, falling toward
cents per 1,000 with the Jev-first cascade already in place here).

## Verification

- `pnpm lint` (Biome, whole repo) · `pnpm -r typecheck` · `pnpm -r test` (85 tests, mocked AWS/Gmail/Anthropic — no live network calls in CI)
- `pnpm -r build` produces every Lambda's `dist/index.mjs` (required before `terraform plan`/`apply`, since `data.archive_file` zips them) and the SPA's `web/dist/`
- GitHub Actions CI (`.github/workflows/ci.yml`) runs all of the above plus `terraform validate` (with `-backend=false`, no AWS credentials needed in CI) on every push/PR
- `terraform validate && terraform plan` clean before every `apply` (all infra is applied and live as of this writing)
- Every phase's UI-facing milestone was driven through an actual browser (Cognito login → review queue → submit a correction → reload → confirm persistence), not just curled
