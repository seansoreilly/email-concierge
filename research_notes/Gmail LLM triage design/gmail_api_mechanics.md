# Gmail API Integration Mechanics for a Personal LLM Triage Tool

## Gmail API vs IMAP: which to use for a personal LLM triage tool

### Takeaway
For a single-user LLM-powered Gmail triage tool, the Gmail REST API is clearly the better choice over IMAP: it gives native label semantics (needed for triage output), efficient incremental sync via `history.list`, push notifications, and batch mutation endpoints that IMAP has no equivalent for. IMAP's only real advantages (protocol universality, no Google Cloud project/OAuth setup) don't matter for a Gmail-only, already-committed-to-Google-Cloud project.

### Cited Findings
- "Gmail API gives you labels, push notifications, and batch operations, while IMAP provides universal coverage across all providers but requires polling or IDLE connections and has no native REST interface" — [IMAP vs Gmail API vs Graph API](https://cli.nylas.com/guides/imap-vs-gmail-api-vs-graph-api)
- IMAP has provider-level bandwidth caps cited as "2500MB (IMAP) and 1250MB (POP)" per day, separate from and in addition to any application-level quota — [Gmail API Limits in 2026](https://www.unipile.com/gmail-api-limits/)
- Recommended IMAP use case: "You need multi-provider support and your use case is read-heavy with limited search requirements... you don't want to register apps with Google... or you're connecting to a self-hosted server" — [IMAP vs Gmail API vs Graph API](https://cli.nylas.com/guides/imap-vs-gmail-api-vs-graph-api)
- Gmail API push notifications are described as "capped at approximately 1 event per second per authenticated user. Bursts above this are batched or delayed, not dropped" — [Gmail API Push Notifications: Complete Guide (2026)](https://www.unipile.com/gmail-api-push-notifications/) (note: this specific per-second push cap figure is from a third-party vendor blog, not found directly in Google's own docs during this research pass — treat as plausible but unconfirmed primary-sourced)
- The Gmail API exposes Gmail's native label model (user labels + system labels like `IMPORTANT`, `CATEGORY_*`) directly, which IMAP only partially maps via non-standard `X-GM-LABELS` extensions (well known from general IMAP/Gmail integration experience, not independently re-confirmed in this pass — flag as an inference from general knowledge, see Gaps).

### Inferences
- Since this is a single Gmail account (not multi-provider) and the tool needs to both read and re-label/archive messages (triage output), the Gmail API's native label/batch-modify support directly maps to the product requirement in a way IMAP's `\Seen`/`\Flagged` flags and non-standard label extensions do not.
- Because the project already requires a Google Cloud project for OAuth regardless of API choice (Gmail requires OAuth 2.0 either way — IMAP access to Gmail also requires OAuth2 or an app password), there's no setup-cost advantage to IMAP here.

### Gaps
- Could not find a primary Google source directly comparing Gmail API vs IMAP (Google doesn't publish such a comparison since IMAP isn't their product); all comparison claims above are from third-party vendor content (Nylas/Unipile), which have a commercial interest in email-API tooling and should be read as reasonably informed but not neutral.
- Did not independently verify the "X-GM-LABELS" IMAP extension claim against current Google documentation in this session.

---

## OAuth scopes: what each grants, and which are restricted/sensitive

### Takeaway
Gmail's scopes span three Google trust tiers — restricted, sensitive, and non-sensitive — and this matters a lot for a personal tool: `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.insert`, and `mail.google.com` are **restricted**, which is the tier that (for apps serving more than a small personal user base) requires Google's CASA security assessment; `gmail.metadata` is also documented as restricted per Google's own scope list; `gmail.settings.basic` and `gmail.labels` are lower-tier (non-sensitive/sensitive) scopes without that assessment requirement.

### Cited Findings
- Scope grants, per Google's own scopes reference:
  - `gmail.labels` — "Allows users to view and modify their email labels" (non-sensitive) — [Gmail API OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
  - `gmail.readonly` — "Permits viewing email messages and account settings only" (restricted) — [same]
  - `gmail.modify` — "Grants read, compose, and send access without permanent deletion authority" (restricted) — [same]
  - `gmail.compose` — "Allows drafting and sending emails without deletion capabilities" (restricted) — [same]
  - `gmail.insert` — "Enables adding emails to a Gmail mailbox" (restricted) — [same]
  - `mail.google.com` — "Provides comprehensive access to read, compose, send, and delete all Gmail content... reserved for applications requiring permanent deletion bypassing trash" (restricted) — [same]
  - `gmail.send` — "Grants permission to send email messages on behalf of users" (sensitive) — [same]
  - `gmail.settings.sharing` — "Manage your sensitive mail settings, including who can manage your mail... limited to administrative and service account use" (sensitive) — [same]
  - `gmail.metadata` — "Provides access to message metadata (labels, headers) excluding message bodies" — listed as restricted per an earlier corroborating search result: "gmail.readonly, gmail.modify, gmail.compose, gmail.insert, and https://mail.google.com/ are classified as restricted scopes" — [Gmail API Scopes Explained (Unipile)](https://www.unipile.com/gmail-api-scopes-guide/). Google's own fetched scopes page in this session did not explicitly show `gmail.settings.basic`'s tier or restate `gmail.metadata`'s tier in the excerpt retrieved — see Gaps.
- "Restricted scopes... require yearly security assessments on top of OAuth verification" — [Gmail API Scopes Explained (Unipile)](https://www.unipile.com/gmail-api-scopes-guide/)
- "Restricted Gmail API scopes require your app to pass Google's security assessment before you can use them in production with more than 100 test users." — [Gmail API Scopes Explained (Unipile)](https://www.unipile.com/gmail-api-scopes-guide/)
- Google's official restricted-scopes list page confirms Gmail API scopes appear in the cross-API "restricted scopes" catalog alongside Drive, Fit, Chat, Data Portability, Photos, and Health APIs, but the fetched excerpt did not itemize which specific Gmail scopes are on that list (see Gaps) — [Restricted Scopes — GCP Console Help](https://support.google.com/cloud/answer/13464325?hl=en)

### Inferences
- For this tool's actual needs (read messages, apply/remove labels for triage, maybe adjust settings/filters), `gmail.modify` + `gmail.labels` (+ possibly `gmail.settings.basic` for filter management) is the minimal practical scope set — this pulls in `gmail.modify`, a restricted scope, so the CASA question cannot be avoided by scope minimization alone unless the tool is read-only (`gmail.readonly`, also restricted) or metadata-only (`gmail.metadata`, also restricted). There is no way to build a triage tool that both reads content and relabels/archives without touching at least one restricted scope.
- Because `gmail.readonly` and `gmail.metadata` are also restricted, there is no lower-tier scope choice available if the tool needs to read message content — the CASA question applies almost regardless of design.

### Gaps
- Did not get a single authoritative Google page enumerating scope-by-scope restricted/sensitive/non-sensitive classification for every Gmail scope in one place during this pass; classification for `gmail.metadata` and `gmail.settings.basic` specifically relies partly on a third-party (Unipile) source rather than a directly-quoted Google primary source. Recommend the report writer/engineer double check current tier for `gmail.metadata` and `gmail.settings.basic` directly against https://developers.google.com/identity/protocols/oauth2/scopes#gmail before finalizing scope requests.

---

## Testing publishing status: 100-user cap and the 7-day refresh token expiry

### Takeaway
The widely-reported behavior is still current as of this research (pages fetched dated September 2026): a Google Cloud OAuth consent screen left in "Testing" publishing status caps the app at 100 test users and — critically — issues refresh tokens that expire after 7 days, forcing repeated re-consent. This applies fully to a personal single-user Gmail tool because Gmail's read/modify scopes are restricted, so the usual "just use fewer than 100 users" exemption from *verification* does not exempt you from the *7-day Testing-mode token expiry*, which is a separate, independent rule keyed off publishing status, not user count or verification status. The commonly used workaround is to flip the OAuth consent screen's publishing status to "In production" (which does not itself require completing verification/CASA for a low-user personal app) — this is reported to remove the 7-day cap even while the app remains formally "unverified," at the cost of the scarier "Google hasn't verified this app" consent screen at each new login.

### Cited Findings
- "When a Google Cloud Platform project has an OAuth consent screen configured for an external user type and a publishing status of 'Testing', refresh tokens expire in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile." — [Unipile: Google OAuth Refresh Token](https://www.unipile.com/google-oauth-refresh-token/)
- "If an application requests gmail.readonly, the 7-day expiration exception does not apply, meaning there is a hard seven-day clock on both the authorization and the refresh token, which restarts only when the user consents again." — [Unipile: Google OAuth Refresh Token](https://www.unipile.com/google-oauth-refresh-token/)
- "Once an app is moved to 'In Production' status, refresh tokens generally don't expire unless they are revoked or remain unused for a prolonged period (typically six months)." — [Unipile: Google OAuth Refresh Token](https://www.unipile.com/google-oauth-refresh-token/)
- "You can navigate to the OAuth consent screen in the Google API Console and change the publishing status to 'In production' to avoid the refresh token expiring in 7 days" — corroborated across multiple sources including a Google AdWords API support forum thread — [Google Groups: Refresh token expires within 7 days - In Production](https://groups.google.com/g/adwords-api/c/WDgwEZT6Cd0)
- Community/developer reports of this exact pain point recur across 2024-2026, e.g. a GitHub issue titled "Gmail authorizations expire every 7 days in Testing status, so every beta connection dies weekly until the app is verified" — [GitHub issue #728](https://github.com/yadava5/applied/issues/728) — and another, "Google OAuth is in Testing: 7-day tokens and a hand-managed 100-account cap" — [GitHub issue #290](https://github.com/yadava5/applied/issues/290)
- On the 100-user cap and verification exemptions specifically: "If your app remains unverified, the unverified app screen will be displayed before the consent screen, and your app will be limited to 100 new users until it is verified" and "If the app is for your personal use (fewer than 100 users), you and your limited number of users can continue using the app without going through verification (users will be allowed to click through 'unverified app' warning screens during sign-in)" — [Google Cloud Platform Console Help: Unverified apps](https://support.google.com/cloud/answer/7454865?hl=en) (via search synthesis; direct fetch of this exact page was not performed in this session — see Gaps)
- Google's own "When is verification not needed" support page (fetched directly) confirms: apps with fewer than 100 users don't require verification; "Apps in development/testing/staging mode are not subject to verification"; internal Workspace-org-only apps face "no unverified app screens or user caps" — [When is verification not needed — GCP Console Help](https://support.google.com/cloud/answer/13464323?hl=en)
- However, this same page (as fetched) did not state any CASA/restricted-scope-specific exemption tied to low user counts — it explicitly notes elsewhere (per the sensitive-scope-verification page) that "if your app utilizes restricted or sensitive scopes, app verification is required" for certain installation modes — [Sensitive scope verification — Google for Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- Sensitive scope verification (a lighter process than full restricted-scope CASA) "typically takes 3-5 business days to complete" — [same page]
- CASA/restricted-scope third-party security assessment cost is reported as "$15,000 – $75,000 or more," varying with implementation complexity and existing security posture, taking "anywhere from a few weeks to multiple months" — [GMASS: My feelings on Google's $15,000-$75,000 OAuth verification process](https://www.gmass.co/blog/google-oauth-verification-security-assessment/)

### Inferences
- For this project specifically: staying in "Testing" status avoids ever triggering CASA (since Google's own guidance says apps in development/testing/staging are not subject to verification at all, restricted scopes included), but locks you into the 7-day refresh-token treadmill, which for an unattended/automated background triage tool is a functional blocker (you can't have a human re-click "Allow" every week indefinitely without it becoming a real maintenance chore).
- The commonly-used escape hatch — set publishing status to "In production" while leaving the app formally unverified — appears to trade the 7-day expiry for a one-time "Google hasn't verified this app" warning-click at each (much less frequent, likely only-once-ever for a single user) consent flow, and per the six-month-inactivity-revocation rule, refresh tokens should then last indefinitely as long as the app makes at least one API call within any 6-month window — which a running triage tool will trivially satisfy.
- This is very much the personal/single-user context called out as different from enterprise SaaS in the task constraints: a multi-tenant SaaS with a restricted scope essentially cannot avoid CASA once it exceeds 100 users or seeks any credibility with real users, whereas a single-user personal tool can most likely legitimately live indefinitely in "In production + unverified" status, since Google's exemption for personal/known-users apps is explicitly documented ("if you are the only user of your app or if your app is used by only a few users, all of whom are known personally to you" — verification not required) — [Sensitive scope verification page, as fetched](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

### Gaps
- Could not confirm from a *primary* Google source, in this pass, an explicit statement that switching to "In production" status (while remaining unverified) is a Google-sanctioned/permanent state rather than a policy gray area that Google could tighten — all direct evidence for this workaround comes from developer forum threads and vendor blogs, not from Google's own docs stating "In production + unverified is fine for personal use, refresh tokens won't expire." Google's own pages describe the *exemption from needing to verify* for personal apps, but the notes above did not find a Google page that explicitly ties refresh-token lifetime behavior to the "In production" toggle for restricted-scope apps. Recommend treating "flip to In Production" as a strong, widely-corroborated community-verified workaround, not an officially documented guarantee — and building in defensive re-auth handling regardless (see reliability recommendation below).
- Did not find any explicit 2026-dated Google announcement changing the 7-day Testing-mode expiry policy itself; all evidence suggests it is unchanged as of September 2026.

---

## Push notifications: users.watch + Cloud Pub/Sub

### Takeaway
Gmail push notifications work by calling `users.watch()` to register a Cloud Pub/Sub topic, after which Gmail publishes a message (containing the account's email address and a new `historyId`) to that topic whenever the mailbox changes; the watch registration expires after at most 7 days and must be renewed by calling `watch()` again before expiration — this is unchanged as of the September 2026 fetch of Google's own guide.

### Cited Findings
- Setup requires: (1) create a Cloud Pub/Sub topic, (2) create a push or pull subscription, (3) grant publish rights to `gmail-api-push@system.gserviceaccount.com`, (4) call `users.watch()` — [Gmail push notifications guide, Google for Developers](https://developers.google.com/workspace/gmail/api/guides/push) (fetched directly, last-updated Sept 15 2026 per fetch)
- "You must call the watch method at least once every 7 days or you'll stop receiving updates for the user." — [same page]
- The `watch()` response includes an `expiration` field (epoch millis timestamp) indicating when the watch will stop delivering — [same page]; also directly documented on the `users.watch` reference — [Method: users.watch](https://developers.google.com/gmail/api/v1/reference/users/watch)
- Recommended practice is to renew more frequently than the 7-day maximum for safety margin: examples cited include daily cron renewal, renewal "every 3 days," "every 6 days," or "1 hour before expiration" — [Gmail API Push Notifications: Complete Guide (Unipile, 2026)](https://www.unipile.com/gmail-api-push-notifications/); [various implementation write-ups, e.g. Torq KB](https://kb.torq.io/en/articles/9138324-receive-gmail-push-notifications-using-google-cloud-pub-sub)
- Delivery goes through Pub/Sub (not a direct webhook from Gmail), which "adds durability: if your endpoint is temporarily unavailable, Pub/Sub can retry delivery according to its subscription ack deadline" — [Unipile: Gmail API Push Notifications](https://www.unipile.com/gmail-api-push-notifications/)
- `users.watch` costs 100 quota units per call — [Gmail API usage limits, Google for Developers, fetched directly](https://developers.google.com/workspace/gmail/api/reference/quota) (page states "Page Last Updated: September 10, 2026")
- No 2026-specific mechanism change was found: the fetched push-notifications guide, as of its September 15 2026 update, describes the same watch/Pub/Sub/history flow as historically documented, with "no significant changes noted to the core push notification mechanism."

### Inferences
- For a personal single-user tool, a daily renewal cron job (well inside the 7-day window) is the safe, low-effort pattern; at 100 quota units per `watch()` call and a 1,200,000 units/minute project cap, renewal cost is negligible.
- Because watch delivers only a bare notification (email + historyId), not message content, every push notification must be followed by a `history.list` call (2 quota units) to find out what actually changed — the push mechanism and the incremental-sync mechanism (below) are not independent; they're designed to be used together.

### Gaps
- Did not find a documented maximum watch-renewal frequency floor (i.e., confirmation that renewing far more often than needed, e.g. hourly, carries no penalty) — inferred to be safe given quota costs, but not explicitly confirmed by Google as a supported pattern versus just "allowed because nothing stops you."

---

## Incremental sync via history.list and historyId

### Takeaway
`history.list` with a stored `startHistoryId` retrieves only the changes since that point, but Google explicitly states history records are only reliably available for about a week (and may expire sooner in rare cases); when the ID is too old the API returns HTTP 404, and the client's only correct recovery is a full resync via `messages.list`/`messages.get`.

### Cited Findings
- "history.list... 'return[s] all history records newer than the startHistoryId query parameter'" — [Synchronizing Clients with Gmail, Google for Developers, fetched directly](https://developers.google.com/workspace/gmail/api/guides/sync)
- "History records are typically available for at least one week and often longer. However, the time period for which records are available might be significantly shorter, and records might be unavailable in rare cases." — [same page, direct quote]
- "If the startHistoryId supplied by your client is outside the available range of history records, the Gmail API returns an HTTP 404 error response. In this case, your client must perform a full sync." — [same page, direct quote]
- Recommended full-sync fallback pattern: call `messages.list` to enumerate current message IDs, batch-fetch details with `messages.get`, and store the `historyId` returned with the most recent message so future syncs can go back to the cheap incremental path — [same page]
- Google recommends combining history-based partial sync with push notifications specifically "to trigger partial synchronization in real time and only when necessary, avoiding needless polling" — [same page, direct quote]
- `history.list` costs only 2 quota units per call, versus 20 for `messages.get` and 5 for `messages.list` — [Gmail API usage limits, fetched directly](https://developers.google.com/workspace/gmail/api/reference/quota)

### Inferences
- For a personal triage tool, the practical design is: persist the last-seen `historyId` (e.g., in local SQLite/config) after every sync cycle; on each wake (whether triggered by a push notification or a poll timer), call `history.list` from the stored ID; on a 404, fall back to a bounded full resync (e.g., `messages.list` scoped to the last N days via `q=newer_than:Nd` to avoid re-scanning the entire mailbox) rather than an unbounded full-history resync.
- Because history retention is "at least a week" but not guaranteed longer, any design where the tool might be offline for more than ~7 days (laptop closed, no server running) needs the full-resync fallback exercised and tested, not treated as a rare edge case — for a personal/local project (vs. an always-on server), this path is likely to be hit routinely, not rarely.

### Gaps
- Google's docs describe retention as "typically at least a week" without a hard documented minimum guarantee; no primary source gives an exact number of hours/days as a firm floor. Design should treat 404-on-stale-historyId as a normal, expected code path rather than an exceptional one.

---

## Polling as an alternative to push notifications

### Takeaway
No primary Google source found in this pass directly recommends or quantifies polling intervals; Google's own sync guide frames polling as the thing push notifications exist to let you *avoid* ("avoiding needless polling"), implying Google's official stance favors push+history over polling, but for a personal single-user tool the operational simplicity of polling (no Cloud Pub/Sub topic, no public/webhook endpoint, no watch-renewal cron) is a legitimate tradeoff against latency and slightly higher quota use.

### Cited Findings
- Google's sync guide phrasing: combine history-based sync with push notifications "to trigger partial synchronization in real time and only when necessary, avoiding needless polling" — [Synchronizing Clients with Gmail](https://developers.google.com/workspace/gmail/api/guides/sync) — this is the only direct primary-source framing of polling found; it is presented as something to minimize, not something forbidden.
- Quota math for polling: a `history.list` poll costs only 2 quota units; even polling every minute (1,440 polls/day) costs 2,880 units/day against an 80,000,000-unit daily project threshold and a 1,200,000-units/minute cap — trivially inside limits — [derived from Gmail API usage limits page](https://developers.google.com/workspace/gmail/api/reference/quota)

### Inferences
- For a genuinely personal, single-user tool that doesn't need sub-minute latency, polling `history.list` on a simple interval (e.g., every 1-5 minutes) is a legitimate, much-simpler-to-operate alternative to push+Pub/Sub: it avoids needing any publicly reachable webhook endpoint, a GCP Pub/Sub topic/subscription, IAM grants to `gmail-api-push@system.gserviceaccount.com`, and a separate watch-renewal cron job — at the cost of up to one polling-interval's worth of latency and (negligibly) more quota usage than pure push.
- Given the "must renew watch every ≤7 days" operational burden and the need for a public HTTPS endpoint or a separate pull-subscription consumer process, polling is arguably the *pragmatically recommended* approach specifically for a single-user local/personal tool, even though Google's own docs favor push for efficiency at scale — this is an inference for this specific use case, not a claim Google makes.

### Gaps
- No source found giving Google's own recommended minimum polling interval or an explicit statement that polling is an acceptable production pattern (Google's docs only discuss it as the alternative push is designed to reduce). This entire section's recommendation-for-personal-use framing is analysis/inference rather than a documented Google position — flagged clearly here per instructions.

---

## Labels, filters, and batch modify

### Takeaway
Gmail distinguishes reserved `SYSTEM` labels (e.g., `INBOX`, `UNREAD`, `IMPORTANT`, `STARRED`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, and the `CATEGORY_*` tab labels) from user-created `USER` labels, and the API exposes `batchModify`/`batchDelete` for bulk label/state changes (max 1,000 message IDs per `batchModify` call) plus a full native filter system (`users.settings.filters`) that can apply labels, forward, archive, mark-as-read, or delete based on from/to/subject/query criteria — meaning some triage logic (e.g., simple sender-based routing) could be delegated to native Gmail filters instead of custom LLM/code logic, reserving the LLM for judgment calls filters can't express.

### Cited Findings
- "Labels come in two varieties: reserved SYSTEM labels and custom USER labels" and "no USER label can be created with the same name as any SYSTEM label" (triggers an HTTP 400 Invalid label name error) — [Manage labels, Google for Developers, fetched directly](https://developers.google.com/workspace/gmail/api/guides/labels)
- System labels identified directly from Google's guide: `INBOX`, `SPAM`, `TRASH`, `UNREAD`, `STARRED`, `IMPORTANT` (manually applicable); `SENT` (auto-applied to messages sent via `drafts.send`); `DRAFT` (auto-applied to all draft messages); `CATEGORY_PERSONAL`, `CATEGORY_SOCIAL`, `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS` (correspond to Gmail's inbox tabs) — [same page]
- Label management specifically only requires the non-sensitive `gmail.labels` scope — [same page]
- `batchModify`: "There is a limit of 1000 ids per request," plus a separate "limit of 20 Classification Label values per request" — [Method: users.messages.batchModify, Google for Developers, fetched directly](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify)
- `batchModify` quota cost: 50 units per call; `batchDelete`: also 50 units per call — [Gmail API usage limits, fetched directly](https://developers.google.com/workspace/gmail/api/reference/quota)
- Gmail's native filter system (`users.settings.filters.create`) supports criteria such as `from`, `to`, `subject`, `query`, `negatedQuery`, `hasAttachment`, `excludeChats`, and actions including `addLabelIds`, `forward` (to an email address), archive, mark-as-read, and delete — [Gmail Filters API structure, synthesized from Google API Python client docs and GAM wiki](https://googleapis.github.io/google-api-python-client/docs/dyn/gmail_v1.users.settings.filters.html); [Users Gmail Filters, GAM-team wiki](https://github.com/GAM-team/GAM/wiki/Users-Gmail-Filters)
- A Gmail account can have "a maximum of 1,000 filters" — [search-synthesized from Google API client docs, cited above] (not independently re-verified against a direct Google quota/limits page in this session — see Gaps)
- Filter management (create/update/delete filters) requires the `gmail.settings.basic` scope — [Gmail API OAuth scopes reference, cross-referenced](https://developer.nylas.com/docs/cookbook/use-cases/build/google-oauth-scopes/) (third-party corroboration; not independently re-confirmed against Google's own scopes page text retrieved in this session, which focused on message/label scopes rather than settings scopes)

### Inferences
- Because `CATEGORY_*` labels are Gmail's own ML-driven classification (Primary/Social/Promotions/Updates/Forums), an LLM triage layer could treat these as free input signal (already computed by Gmail) rather than needing to reproduce that classification itself — worth reading at ingestion time rather than ignoring.
- Native Gmail filters are a good fit for *static, rule-expressible* triage (e.g., "anything from noreply@ goes to a Bulk label and skips the inbox", "anything with subject containing 'invoice' gets labeled Finance") — this can run at zero ongoing LLM cost and zero API-call cost (filters execute inside Gmail itself on delivery). The LLM/custom-code layer is then only needed for triage decisions that require semantic judgment (urgency, sentiment, "does this need a reply") that static from/subject/query rules can't express — a reasonable architectural split to note in design.
- `batchModify`'s 1,000-message cap combined with its 50-unit cost means a bulk one-time reclassification of, say, a 10,000-message inbox costs about 10 `batchModify` calls (500 units) plus whatever `messages.get`/`messages.list` calls were needed to decide the new labels in the first place — the bottleneck for a bulk classification job is almost certainly the `messages.get` (20 units each) or LLM-inference cost per message, not the batch-write step.

### Gaps
- Did not independently verify the "1,000 filters per account" cap and the exact `gmail.settings.basic` scope requirement against a directly-fetched Google primary-source page in this session (both came from secondary sources / API client library docs). Recommend a quick direct check of https://developers.google.com/workspace/gmail/api/guides/filter_settings before finalizing design.
- Did not find documented `batchDelete` message-ID-per-request limit (only found it for `batchModify`); likely the same 1,000, but unconfirmed from a primary source in this pass.

---

## Rate limits and quota units for a bulk-classification job

### Takeaway
As of a September 10, 2026 Google page (fetched directly), Gmail API quota limits (updated project-wide as of May 1, 2026) are 1,200,000 quota units/minute/project and 6,000 quota units/minute/user/project, with an 80,000,000 quota-unit/day-per-project *billing* threshold that doesn't yet trigger charges; per-method costs are cheap for list/metadata calls and much more expensive for full message reads and sends, which should directly drive the design of any bulk-classification job (batch cheaply, read message bodies only once, cache aggressively).

### Cited Findings
- "Gmail API quota limits changed on May 1, 2026 for new Cloud projects, with 1,200,000 quota units per minute per project and 6,000 per minute per user per project. Google also added an 80,000,000 quota-unit daily billing threshold per project, though this does not trigger billing yet; Google says full billing details will come later in 2026 with at least 90 days of notice." — [Gmail API Quotas in 2026, Nylas](https://cli.nylas.com/guides/gmail-api-quotas-2026) — this is a secondary/vendor source; the specific "changed on May 1, 2026" claim and the "at least 90 days notice for billing" claim were not independently cross-checked against a Google announcement/changelog in this session (see Gaps).
- Per-method quota costs, directly fetched from Google's own usage-limits reference (page marked "Page Last Updated: September 10, 2026"):
  - `messages.get`: 20 units
  - `messages.list`: 5 units
  - `messages.batchModify`: 50 units
  - `messages.batchDelete`: 50 units
  - `messages.send`: 100 units
  - `users.watch`: 100 units
  - `history.list`: 2 units
  - `threads.get`: 40 units
  - `threads.list`: 10 units
  - `drafts.get`: 20 units
  - `drafts.list`: 5 units
  - `drafts.send`: 100 units
  - `labels.create`/`update`/`delete`: 5 units
  - `labels.get`/`list`: 1 unit
  — [Gmail API Usage Limits and Quota Costs, Google for Developers](https://developers.google.com/workspace/gmail/api/reference/quota) (directly fetched)
  - A separately-sourced figure claims "listing messages costs 5 units, fetching a full message costs 5 units" and a per-user-per-second figure of "250 quota units per user per second" — [Unipile: Gmail API Limits in 2026](https://www.unipile.com/gmail-api-limits/) — this **conflicts** with the directly-fetched Google page's 20-unit cost for `messages.get` and with the per-*minute* (not per-second) framing above; treat the Unipile per-second figure and its "5 units for messages.get" claim as likely stale/incorrect relative to the directly-fetched September 2026 Google page, which should be treated as authoritative.
- The outgoing-message recipient limit is "500 recipients per email message" (not directly relevant to a read/triage-focused tool, but relevant if the tool ever auto-replies) — [Gmail API usage limits, fetched directly](https://developers.google.com/workspace/gmail/api/reference/quota)

### Inferences
- For a bulk-classification job over an existing inbox (e.g., a one-time pass over N historical messages), the dominant quota cost is `messages.get` at 20 units each: at the per-minute-per-user cap of 6,000 units, that's roughly 300 `messages.get` calls/minute sustainable per user before throttling — for a personal single-user mailbox this is very unlikely to be a real bottleneck (a 10,000-message backlog would take on the order of ~33 minutes of steady `messages.get` calls at the cap, and in practice you'd batch requests via HTTP batching or `format=metadata`/`minimal` to cut cost further where full body isn't yet needed).
- Design implication: use `messages.list` (5 units) to enumerate candidates and `format=metadata` reads where only headers/labels are needed (cheaper than `format=full`, though the exact discounted cost for metadata-format `messages.get` wasn't separately broken out in the fetched quota table — worth confirming), reserving full-body fetches for messages that actually need LLM content analysis. Use `history.list` (2 units) for steady-state incremental sync rather than repeated `messages.list` scans.
- Given the 6,000 units/minute/user cap, a single-user personal tool is essentially never going to be rate-limited by Google under normal operation (even continuous polling + occasional bulk reclassification) unless it tries to read full bodies of thousands of messages within seconds.

### Gaps
- Could not fully confirm, from a primary Google source in this session, whether `messages.get` cost varies by `format` parameter (e.g., `minimal`/`metadata` vs `full`/`raw`) — the fetched quota table gave a single flat 20-unit figure for `messages.get` without a format breakdown. This is worth a direct check before finalizing a bulk-job cost model, since format-based cost differences (if they exist) would materially change the batch-sizing math above.
- The "changed May 1, 2026" and "1,200,000/6,000 units per minute" figures, while consistent between the directly-fetched Google page and a secondary vendor page, were fetched via an AI-summarized WebFetch pass rather than visually confirmed against raw HTML; treat the exact numbers as high-confidence but not literally hand-verified byte-for-byte.
- Did not find a documented per-second (as opposed to per-minute) rate limit from a primary Google source; the per-second framing came only from a vendor blog and appears possibly outdated/conflicting (see above) — recommend relying on the per-minute figures from Google's own directly-fetched page.

---

## Overall design note for the report writer

This tool sits squarely in the "personal/single-user, not enterprise SaaS" context the task flagged as different: the CASA/verification cost and process ($15k-75k+, weeks-to-months, per third-party estimate) is essentially irrelevant here because Google explicitly exempts apps "used by only a few users, all of whom are known personally to you" from verification — the only real friction specific to this project is the Testing-status 7-day refresh-token expiry, which has a well-corroborated (though not fully Google-documented) workaround of setting publishing status to "In production" while remaining unverified. Push notifications (watch+Pub/Sub) are the Google-recommended pattern but carry real operational overhead (public endpoint or pull subscriber, GCP topic/subscription setup, weekly watch renewal) that a simple polling loop against `history.list` avoids at negligible quota cost for a single mailbox — this tradeoff should be presented as a live design decision, not a foregone conclusion, since Google's own docs favor push but don't forbid or penalize polling for a workload this small.
