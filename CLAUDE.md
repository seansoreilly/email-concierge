# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gmail triage MVP: polls an inbox, classifies each new message with a typed decision model
(Jev, primary) and an LLM fallback (Claude Haiku), applies Gmail labels, and drafts replies
(never sent) for messages that need a response. A Cognito-gated review-queue web UI shows every
classification and lets a human correct it. It's a demo of AWS solutions-architecture judgment,
not a production tool — see the README's ADR sections for the reasoning behind every
infrastructure choice (Terraform vs CDK, HTTP API vs REST, Lambda vs Fargate, DynamoDB vs RDS,
etc.) before proposing an architecture change; those tradeoffs are almost certainly already
considered there.

## Commands

pnpm workspaces (`shared`, `services/*`, `scripts`, `web`), run from repo root unless noted.

```bash
pnpm install               # after any package.json change
pnpm -r build              # builds every Lambda's dist/index.mjs (esbuild) + web/dist/ — required before `terraform plan/apply`
pnpm lint                  # biome check . (whole repo, one config for everything)
pnpm -r typecheck          # tsc --noEmit in every workspace
pnpm -r test               # vitest run in every workspace (85 tests; AWS/Gmail/Anthropic all mocked, no live network)
pnpm seed                  # loads shared/fixtures/ into DynamoDB (EMAILS_TABLE_NAME env, defaults to live table)
```

Single-package / single-test loops (faster than `-r` during iteration):

```bash
pnpm --filter @email-concierge/classifier test
pnpm --filter @email-concierge/classifier test -- jev-classifier   # vitest name filter
pnpm --filter @email-concierge/gmail-client test -- safety-boundary
```

Package names follow `@email-concierge/<dir-name>` (e.g. `services/classifier` →
`@email-concierge/classifier`) — check the workspace's own `package.json` `name` field if unsure.

Deploying the web SPA: `scripts/deploy-web.sh` (reads Terraform outputs, runs `pnpm --filter web
build`, zips, pushes via Amplify's manual-deployment API — there is no GitHub-connected CI/CD).

Infra: `cd infra && terraform validate && terraform plan` before every `apply`. CI runs
`terraform validate -backend=false` (no AWS creds needed) but never `apply` — applies are manual,
local, against the single live state.

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

Three Lambdas, one DynamoDB table for state (`emails`), one for a poll sync cursor, one Secrets
Manager secret for the Gmail OAuth refresh token, one Cognito pool with a single admin-created
user (optionally federated with Google — see below).

**`shared/types.ts`** is the taxonomy source of truth (Zod schemas): `ResponseState` (To
Respond / Awaiting Reply / FYI / Done), `ContentTag`, `Priority` (2–10), `EmailRecord`,
`CorrectionRecord`. Every service imports these rather than redefining shapes locally.

**Classification cascade** (`services/classifier/src/cascading-classifier.ts`): heuristic filter
first (`heuristic-filter.ts`, cheap deterministic rules, no API call), then Jev
(`jev-classifier.ts`, primary — typed decision model via OpenRouter, batches all three
questions/email in one call), falling back to Haiku (`haiku-classifier.ts`) only on Jev
error/timeout. Haiku is also the only generator used for draft bodies (`draft-lambda`) — Jev is
explicitly non-generative and structurally can't do that job.

**`services/gmail-client/` — the one safety-critical module.** This is the *only* place in the
repo permitted to import `googleapis`. The "no send, ever" invariant (`gmail.modify` scope
technically permits `messages.send`; there's no narrower scope) is enforced entirely in code
here, not by OAuth scope, via: a fixed allowlist of nine Gmail API methods with no passthrough,
`batchModify()` validating every label ID against an allowlist of app-owned `Concierge/*` labels,
and drafts always requiring a `threadId`. Three CI tests in
`services/gmail-client/src/safety-boundary.test.ts` police this boundary by static analysis (repo-
wide grep for `googleapis`/`@googleapis/*` imports outside this dir, a scoped grep for
`.messages.send(`/`.drafts.send(` inside it, and a positive allowlist check of every
`.users.<resource>.<method>(` call actually made). **When touching this module or adding any
Gmail API call, read that test file first** — it documents exactly what's allowed and why a naive
repo-wide `.send(` grep would be wrong (AWS SDK v3's `client.send(new Command())` shape would
false-positive).

**Not agentic, by design** (see README's ADR): fixed pipeline, not an agent loop. Jev is a
typed decision model, not a reasoning loop; Haiku is called for exactly two single-shot tasks
(classify, draft) with no tool access or multi-step planning. Don't introduce agentic/tool-loop
patterns here without discussing it — it's an explicit scope boundary, not an oversight.

**Draft generation is decoupled via DynamoDB Streams**, filtered to `INSERT` events where
`responseState == "To Respond"` — `draft-lambda` doesn't poll or get called synchronously by
`poll-lambda`.

## Repo layout

```
infra/          Terraform — single state (S3 backend), single apply, one module of .tf files
services/
  gmail-client/  thin Gmail API wrapper — see safety boundary above
  classifier/    Classifier interface: JevClassifier (primary), HaikuClassifier (fallback), CascadingClassifier
  poll-lambda/   EventBridge Scheduler target — polls, classifies, labels
  draft-lambda/  DynamoDB Streams target — generates and creates draft replies
  api-lambda/    API Gateway target — serves the review queue, handles corrections
shared/
  types.ts       Zod schemas: the taxonomy, EmailRecord, CorrectionRecord
  fixtures/      13 synthetic emails covering every taxonomy value, for tests and demo seeding
web/             Vite + React + TS SPA — Cognito login (SRP + optional Google), review queue, correction UI
scripts/
  seed-fixtures.ts    loads shared/fixtures/ into DynamoDB for a live-data-free demo
  oauth-bootstrap.ts  one-time local script: Gmail OAuth consent → Secrets Manager (must be run locally, needs a browser — never runs on AWS)
  deploy-web.sh       manual Amplify deployment (build → zip → upload → start-deployment)
```

Each Lambda service (`poll-lambda`, `draft-lambda`, `api-lambda`) builds with esbuild to a single
`dist/index.mjs`, bundling everything except `@aws-sdk/*` (kept external — provided by the Node
22 Lambda runtime). Terraform's `data.archive_file` zips that `dist/` output, so `pnpm -r build`
must run before `terraform plan`/`apply` picks up a code change.

## Conventions

- TypeScript strict mode repo-wide (`tsconfig.base.json`): `noUncheckedIndexedAccess` on, ESM
  everywhere (`"type": "module"`), `moduleResolution: "Bundler"`.
- Biome (not eslint/prettier) is the single formatter+linter for the whole repo — one root
  `biome.json`, `noExplicitAny` and `noNonNullAssertion` are hard errors on top of recommended
  rules. Run `pnpm lint`, don't hand-format.
- Two different Google OAuth clients exist and are easy to confuse: a **Desktop app** client
  (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars, used server-side by `poll-lambda`/
  `draft-lambda` via `scripts/oauth-bootstrap.ts`) for Gmail API access, and a separate **Web
  application** client (`google_oauth_client_id`/`google_oauth_client_secret` Terraform vars) used
  only for the web UI's "Sign in with Google" button via Cognito Hosted UI
  (`infra/cognito_google_restrict.tf` restricts that login to the single configured user). Email/
  password (Cognito SRP) sign-in is independent of both and always works.
- Local web dev must bind to `http://localhost:5173/`, not `127.0.0.1` — Cognito's callback
  allowlist treats `localhost` as its one http exception. On WSL2 this means `vite --host
  localhost` (or no `--host` override), not `--host 127.0.0.1`.
- Tests mock all external boundaries (AWS via `aws-sdk-client-mock`, Gmail via fakes, Anthropic/
  OpenRouter via fakes) — there is no live-network test tier and no live-model accuracy
  evaluation harness in this repo.
