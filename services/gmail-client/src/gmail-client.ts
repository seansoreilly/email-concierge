import { createServer } from "node:http";
import { type gmail_v1, google } from "googleapis";
import { expectedTaxonomyLabelNames, isAppOwnedLabelName } from "./labels.js";

/**
 * This module is the ONLY place in the repo allowed to import
 * "googleapis" or construct a Gmail API client. That confinement is
 * verified (not proven — see safety-boundary.test.ts) by a repo-wide
 * grep test. It exists because Gmail's OAuth `gmail.modify` scope,
 * needed for both label writes and draft creation, also technically
 * permits `messages.send` — there is no narrower OAuth scope. So the
 * "this app can never send email" boundary has to be enforced in code,
 * not by OAuth scope alone:
 *
 *   1. Only this module may reach the Gmail API at all.
 *   2. This module exposes only a fixed allowlist of methods (below) —
 *      no generic passthrough, no way to call arbitrary Gmail methods.
 *      messages.send / drafts.send / messages.trash / messages.delete
 *      are deliberately not exposed.
 *   3. batchModify() additionally validates every label ID against an
 *      allowlist of labels this app created/owns, so even a bug
 *      elsewhere in this file can't be used to apply or remove an
 *      arbitrary Gmail label (e.g. TRASH, SPAM).
 *   4. Drafts are always created with a threadId, so they sit inert in
 *      an existing thread rather than as a standalone draft.
 */

export interface GmailClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type GmailMessage = gmail_v1.Schema$Message;
export type GmailLabel = gmail_v1.Schema$Label;
export type GmailDraft = gmail_v1.Schema$Draft;
export type GmailHistoryListResponse = gmail_v1.Schema$ListHistoryResponse;
export type GmailMessagesListResponse = gmail_v1.Schema$ListMessagesResponse;
export type GmailLabelsListResponse = gmail_v1.Schema$ListLabelsResponse;

/** Thrown by historyList() when Gmail returns 404 (startHistoryId too old/expired). */
export class GmailHistoryExpiredError extends Error {
  constructor(startHistoryId: string) {
    super(
      `Gmail history cursor "${startHistoryId}" has expired (404). Caller should fall back to a fresh messagesList() backfill.`,
    );
    this.name = "GmailHistoryExpiredError";
  }
}

/** Thrown by createGmailClientFromSecret() when the Gmail OAuth secret has no value yet. */
export class GmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Gmail OAuth secret has no value yet (scripts/oauth-bootstrap.ts hasn't been run). Skipping Gmail-dependent work for this invocation.",
    );
    this.name = "GmailNotConfiguredError";
  }
}

function isGoogleApiError(err: unknown): err is { code: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "number"
  );
}

export interface ParsedMessage {
  messageId: string;
  threadId: string;
  historyId: string | undefined;
  from: string;
  subject: string;
  snippet: string;
  bodyText: string;
  receivedAt: string;
  headers: { listUnsubscribe?: string; precedence?: string };
  labelIds: string[];
}

const MAX_BODY_TEXT_BYTES = 10_000;

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    undefined
  );
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Walks a MIME part tree depth-first looking for the first part matching mimeType. */
function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function extractBodyText(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return "";

  const plainPart = findPart(payload, "text/plain");
  if (plainPart?.body?.data) {
    return decodeBase64Url(plainPart.body.data);
  }

  const htmlPart = findPart(payload, "text/html");
  if (htmlPart?.body?.data) {
    return stripHtml(decodeBase64Url(htmlPart.body.data));
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}

/** Converts a raw googleapis Gmail message into the shape poll-lambda/draft-lambda consume. */
export function parseGmailMessage(raw: GmailMessage): ParsedMessage {
  const headers = raw.payload?.headers;
  const bodyText = extractBodyText(raw.payload).slice(0, MAX_BODY_TEXT_BYTES);
  const internalDateMs = raw.internalDate
    ? Number(raw.internalDate)
    : Number.NaN;

  return {
    messageId: raw.id ?? "",
    threadId: raw.threadId ?? "",
    historyId: raw.historyId ?? undefined,
    from: headerValue(headers, "From") ?? "",
    subject: headerValue(headers, "Subject") ?? "",
    snippet: raw.snippet ?? "",
    bodyText,
    receivedAt: Number.isFinite(internalDateMs)
      ? new Date(internalDateMs).toISOString()
      : new Date().toISOString(),
    headers: {
      listUnsubscribe: headerValue(headers, "List-Unsubscribe"),
      precedence: headerValue(headers, "Precedence"),
    },
    labelIds: raw.labelIds ?? [],
  };
}

/**
 * Narrow surface of the underlying googleapis Gmail client that this
 * wrapper is allowed to touch. This type IS the method allowlist at
 * compile time: GmailClientImpl only ever calls through this interface,
 * so it has no way to reach `gmail.users.messages.send` or any other
 * method not listed here, even by typo or copy-paste. Kept separate
 * from gmail_v1.Gmail's own (heavily overloaded) method signatures so
 * fakes/mocks in tests stay simple.
 */
export interface GmailApiSurface {
  historyList(
    params: gmail_v1.Params$Resource$Users$History$List,
  ): Promise<{ data: GmailHistoryListResponse }>;
  messagesList(
    params: gmail_v1.Params$Resource$Users$Messages$List,
  ): Promise<{ data: GmailMessagesListResponse }>;
  messagesGet(
    params: gmail_v1.Params$Resource$Users$Messages$Get,
  ): Promise<{ data: GmailMessage }>;
  messagesBatchModify(
    params: gmail_v1.Params$Resource$Users$Messages$Batchmodify,
  ): Promise<void>;
  labelsList(
    params: gmail_v1.Params$Resource$Users$Labels$List,
  ): Promise<{ data: GmailLabelsListResponse }>;
  labelsCreate(
    params: gmail_v1.Params$Resource$Users$Labels$Create,
  ): Promise<{ data: GmailLabel }>;
  draftsCreate(
    params: gmail_v1.Params$Resource$Users$Drafts$Create,
  ): Promise<{ data: GmailDraft }>;
  draftsGet(
    params: gmail_v1.Params$Resource$Users$Drafts$Get,
  ): Promise<{ data: GmailDraft }>;
  draftsDelete(
    params: gmail_v1.Params$Resource$Users$Drafts$Delete,
  ): Promise<void>;
}

/**
 * Builds the authenticated googleapis Gmail client and adapts it to
 * GmailApiSurface. Each method is arrow-wrapped (not destructured off
 * `gmail.users.*`) because destructuring would drop the `this` binding
 * the googleapis client relies on internally.
 *
 * This only accepts already-obtained OAuth2 credentials (refresh token
 * + client id/secret) — it does not implement the OAuth bootstrap/
 * consent flow. That's scripts/oauth-bootstrap.ts in a later phase.
 * Callers (e.g. poll-lambda) are responsible for sourcing these values
 * from AWS Secrets Manager; this module never reads env vars itself.
 */
export function buildGmailApiSurface(
  config: GmailClientConfig,
): GmailApiSurface {
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });
  const gmail = google.gmail({ version: "v1", auth });

  return {
    historyList: (params) => gmail.users.history.list(params),
    messagesList: (params) => gmail.users.messages.list(params),
    messagesGet: (params) => gmail.users.messages.get(params),
    messagesBatchModify: async (params) => {
      await gmail.users.messages.batchModify(params);
    },
    labelsList: (params) => gmail.users.labels.list(params),
    labelsCreate: (params) => gmail.users.labels.create(params),
    draftsCreate: (params) => gmail.users.drafts.create(params),
    draftsGet: (params) => gmail.users.drafts.get(params),
    draftsDelete: async (params) => {
      await gmail.users.drafts.delete(params);
    },
  };
}

const USER_ID = "me";

export class LabelAllowlistNotLoadedError extends Error {
  constructor() {
    super(
      "Label allowlist has not been loaded yet. Call refreshLabelAllowlist() before batchModify().",
    );
    this.name = "LabelAllowlistNotLoadedError";
  }
}

export class LabelNotAllowedError extends Error {
  constructor(labelId: string) {
    super(
      `Refusing batchModify: label ID "${labelId}" is not in the app-owned label allowlist. Only labels under the Concierge/ namespace, loaded via refreshLabelAllowlist(), may be applied or removed.`,
    );
    this.name = "LabelNotAllowedError";
  }
}

/**
 * Gmail API wrapper. Exposes exactly nine methods; nothing else Gmail
 * offers is reachable through it. See the module-level comment above
 * for the full safety rationale.
 */
export class GmailClient {
  private readonly api: GmailApiSurface;
  private labelAllowlist: Map<string, string> | undefined;

  constructor(api: GmailApiSurface) {
    this.api = api;
  }

  /**
   * Wraps history.list's own pagination + a typed error for the specific
   * 404 case (startHistoryId too old / expired) so callers can distinguish
   * "no new mail" from "cursor expired, fall back to a fresh backfill"
   * without inspecting raw HTTP status codes themselves.
   */
  async historyList(params: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<{
    messageIdsAdded: string[];
    historyId: string | undefined;
    nextPageToken: string | undefined;
  }> {
    let data: GmailHistoryListResponse;
    try {
      const result = await this.api.historyList({
        userId: USER_ID,
        startHistoryId: params.startHistoryId,
        pageToken: params.pageToken,
      });
      data = result.data;
    } catch (err) {
      if (isGoogleApiError(err) && err.code === 404) {
        throw new GmailHistoryExpiredError(params.startHistoryId);
      }
      throw err;
    }

    const messageIdsAdded = (data.history ?? []).flatMap(
      (entry) =>
        entry.messagesAdded
          ?.map((m) => m.message?.id)
          .filter((id): id is string => Boolean(id)) ?? [],
    );

    return {
      messageIdsAdded,
      historyId: data.historyId ?? undefined,
      nextPageToken: data.nextPageToken ?? undefined,
    };
  }

  /**
   * Restricted to the inbox and a bounded lookback so Phase 5's own
   * generated drafts (which live outside INBOX, in the thread they were
   * created against) never show up here and get reclassified.
   */
  async messagesList(params: {
    query?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{ messageIds: string[]; nextPageToken: string | undefined }> {
    const { data } = await this.api.messagesList({
      userId: USER_ID,
      q: params.query,
      pageToken: params.pageToken,
      maxResults: params.maxResults,
      labelIds: ["INBOX"],
    });
    return {
      messageIds: (data.messages ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id)),
      nextPageToken: data.nextPageToken ?? undefined,
    };
  }

  async messagesGetRaw(messageId: string): Promise<GmailMessage> {
    const { data } = await this.api.messagesGet({
      userId: USER_ID,
      id: messageId,
      format: "full",
    });
    return data;
  }

  /**
   * messagesGetRaw() plus MIME parsing into the shape poll-lambda/
   * draft-lambda actually need: decoded body text (text/plain preferred,
   * HTML stripped as a fallback), pulled headers, and receivedAt. Body is
   * truncated to ~10KB - DynamoDB items cap at 400KB total, and a smaller
   * body also bounds how much untrusted email content a classifier prompt
   * ever sees (defense in depth against prompt injection in mail bodies).
   */
  async messagesGet(messageId: string): Promise<ParsedMessage> {
    const raw = await this.messagesGetRaw(messageId);
    return parseGmailMessage(raw);
  }

  /**
   * Applies/removes labels on a batch of messages. Every ID in
   * addLabelIds and removeLabelIds must be in the app-owned label
   * allowlist (see refreshLabelAllowlist) or this throws instead of
   * calling the Gmail API. This is the code-level backstop for the
   * fact that the gmail.modify OAuth scope has no way to permit label
   * writes while forbidding messages.send.
   */
  async batchModify(
    messageIds: string[],
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) {
      throw new Error("batchModify: messageIds must not be empty.");
    }
    const allowlist = this.requireLabelAllowlist();
    const allowedIds = new Set(allowlist.values());
    for (const labelId of [...addLabelIds, ...removeLabelIds]) {
      if (!allowedIds.has(labelId)) {
        throw new LabelNotAllowedError(labelId);
      }
    }
    await this.api.messagesBatchModify({
      userId: USER_ID,
      requestBody: {
        ids: messageIds,
        addLabelIds,
        removeLabelIds,
      },
    });
  }

  async labelsList(): Promise<GmailLabel[]> {
    const { data } = await this.api.labelsList({ userId: USER_ID });
    return data.labels ?? [];
  }

  /**
   * Creates a label. Restricted in code to names under the app's
   * Concierge/ namespace (see labels.ts) so this method can't be used
   * to create arbitrary top-level labels that would then need to be
   * (mis)trusted elsewhere.
   */
  async labelsCreate(name: string): Promise<GmailLabel> {
    if (!isAppOwnedLabelName(name)) {
      throw new Error(
        `labelsCreate: refusing to create label "${name}" — it is outside the app-owned Concierge/ namespace.`,
      );
    }
    const { data } = await this.api.labelsCreate({
      userId: USER_ID,
      requestBody: { name },
    });
    return data;
  }

  /**
   * Loads labels.list, filters to app-owned labels (Concierge/ prefix),
   * creates any missing labels from the known taxonomy (derived from
   * shared/types.ts's ResponseState and ContentTag enums), and caches
   * the resulting label-name -> ID map. batchModify() validates every
   * label ID it's asked to touch against this cache.
   */
  async refreshLabelAllowlist(): Promise<ReadonlyMap<string, string>> {
    const existing = await this.labelsList();
    const allowlist = new Map<string, string>();
    for (const label of existing) {
      if (label.name && label.id && isAppOwnedLabelName(label.name)) {
        allowlist.set(label.name, label.id);
      }
    }

    const missing = expectedTaxonomyLabelNames().filter(
      (name) => !allowlist.has(name),
    );
    for (const name of missing) {
      const created = await this.labelsCreate(name);
      if (created.name && created.id) {
        allowlist.set(created.name, created.id);
      }
    }

    this.labelAllowlist = allowlist;
    return allowlist;
  }

  private requireLabelAllowlist(): ReadonlyMap<string, string> {
    if (!this.labelAllowlist) {
      throw new LabelAllowlistNotLoadedError();
    }
    return this.labelAllowlist;
  }

  /**
   * Creates a draft reply that sits inert in an existing thread. Always
   * requires threadId — there is no way to call this without one — so
   * this wrapper can never produce a standalone, unlinked draft.
   *
   * `rawMessage` must already be a caller-encoded base64url RFC 2822
   * message (including any In-Reply-To / References headers needed to
   * thread correctly); this method does no message construction itself.
   */
  async draftsCreate(
    threadId: string,
    rawMessage: string,
  ): Promise<GmailDraft> {
    if (!threadId) {
      throw new Error(
        "draftsCreate: threadId is required — standalone drafts are not allowed.",
      );
    }
    const { data } = await this.api.draftsCreate({
      userId: USER_ID,
      requestBody: {
        message: {
          threadId,
          raw: rawMessage,
        },
      },
    });
    return data;
  }

  async draftsGet(draftId: string): Promise<GmailDraft> {
    const { data } = await this.api.draftsGet({
      userId: USER_ID,
      id: draftId,
    });
    return data;
  }

  async draftsDelete(draftId: string): Promise<void> {
    await this.api.draftsDelete({
      userId: USER_ID,
      id: draftId,
    });
  }
}

export function createGmailClient(config: GmailClientConfig): GmailClient {
  return new GmailClient(buildGmailApiSurface(config));
}

interface SecretsManagerClientLike {
  send(command: unknown): Promise<{ SecretString?: string }>;
}

/**
 * Fetches {clientId, clientSecret, refreshToken} JSON from the given
 * Secrets Manager secret ARN and constructs a ready-to-use GmailClient
 * with its label allowlist already loaded. This is the one place all
 * three Lambdas should go to get a Gmail client from Terraform-provisioned
 * config, rather than each hand-rolling the Secrets Manager call.
 *
 * Throws GmailNotConfiguredError (not a generic error) when the secret
 * exists but has no version yet - the normal state between "Terraform
 * apply" and "someone ran scripts/oauth-bootstrap.ts". Callers should
 * catch this specifically and no-op cleanly rather than crash-loop.
 */
export async function createGmailClientFromSecret(
  secretArn: string,
  secretsClient: SecretsManagerClientLike,
  GetSecretValueCommand: new (input: {
    SecretId: string;
  }) => unknown,
): Promise<GmailClient> {
  let secretString: string | undefined;
  try {
    const result = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    secretString = result.SecretString;
  } catch (err) {
    if (isResourceNotFoundOrNoVersion(err)) {
      throw new GmailNotConfiguredError();
    }
    throw err;
  }

  if (!secretString) {
    throw new GmailNotConfiguredError();
  }

  const parsed: unknown = JSON.parse(secretString);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("clientId" in parsed) ||
    !("clientSecret" in parsed) ||
    !("refreshToken" in parsed)
  ) {
    throw new GmailNotConfiguredError();
  }

  const config = parsed as GmailClientConfig;
  const client = createGmailClient(config);
  await client.refreshLabelAllowlist();
  return client;
}

function isResourceNotFoundOrNoVersion(err: unknown): boolean {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  return (
    name === "ResourceNotFoundException" || name === "ResourceNotFoundError"
  );
}

/**
 * The ONLY OAuth-consent-flow surface this module exposes, used exclusively
 * by scripts/oauth-bootstrap.ts (a local, one-time, interactive script - never
 * called from a Lambda). Runs Google's OAuth2 "Desktop app" loopback flow:
 * starts a temporary local HTTP server on `port`, opens the consent URL in
 * the user's browser (the caller must do the opening - this function only
 * returns the URL and waits for the redirect), and exchanges the returned
 * authorization code for a refresh token.
 */
export async function runLoopbackConsentFlow(config: {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  port: number;
}): Promise<{ refreshToken: string; consentUrl: string }> {
  const redirectUri = `http://127.0.0.1:${config.port}`;
  const auth = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    redirectUri,
  );
  const consentUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: config.scopes,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.end(
        authCode
          ? "Authorization received. You can close this tab."
          : `Authorization failed: ${error ?? "unknown error"}`,
      );
      server.close();
      if (authCode) {
        resolve(authCode);
      } else {
        reject(new Error(`OAuth consent denied or failed: ${error}`));
      }
    });
    server.listen(config.port);
  });

  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. This usually means consent was already granted previously without prompt=consent/access_type=offline - revoke the app's access at https://myaccount.google.com/permissions and try again.",
    );
  }

  return { refreshToken: tokens.refresh_token, consentUrl };
}
