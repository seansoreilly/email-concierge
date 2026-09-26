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

  async historyList(startHistoryId: string): Promise<GmailHistoryListResponse> {
    const { data } = await this.api.historyList({
      userId: USER_ID,
      startHistoryId,
    });
    return data;
  }

  async messagesList(query?: string): Promise<GmailMessagesListResponse> {
    const { data } = await this.api.messagesList({
      userId: USER_ID,
      q: query,
    });
    return data;
  }

  async messagesGet(messageId: string): Promise<GmailMessage> {
    const { data } = await this.api.messagesGet({
      userId: USER_ID,
      id: messageId,
    });
    return data;
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
