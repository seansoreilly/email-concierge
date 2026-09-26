import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Classifier } from "@email-concierge/classifier";
import { createDefaultClassifier } from "@email-concierge/classifier";
import type { GmailClient, ParsedMessage } from "@email-concierge/gmail-client";
import {
  GmailHistoryExpiredError,
  GmailNotConfiguredError,
  createGmailClientFromSecret,
} from "@email-concierge/gmail-client";
import {
  contentTagLabelName,
  responseStateLabelName,
} from "@email-concierge/gmail-client/src/labels.ts";
import type { EmailRecord } from "@email-concierge/shared";
import type { Context, ScheduledEvent } from "aws-lambda";

/**
 * Real handler for the EventBridge Scheduler -> poll-lambda wiring.
 *
 * Behavior contract (see agent_docs / Phase 4 plan for the full rationale):
 *  - If the Gmail OAuth secret has no value yet (GmailNotConfiguredError),
 *    this is an EXPECTED, non-error condition: log and return 200 cleanly.
 *    The schedule fires every 2 minutes starting the moment this deploys,
 *    potentially long before a human runs scripts/oauth-bootstrap.ts.
 *  - First run (no sync_state cursor yet): backfill via messagesList(),
 *    capped at BACKFILL_PAGE_SIZE messages per invocation, paging across
 *    invocations via a persisted pageToken.
 *  - Subsequent runs: historyList() from the persisted historyId cursor.
 *    A GmailHistoryExpiredError (stale cursor) falls back to a fresh
 *    backfill rather than crash-looping.
 *  - Each message is written with a single conditional PutItem carrying
 *    the FULL classification already set (never put-then-update) so the
 *    DynamoDB Streams -> draft-lambda INSERT filter on
 *    classification.responseState always sees a fully-populated item.
 *  - A pre-existing item (or a losing conditional PutItem race) is treated
 *    as an idempotent no-op, not an error.
 */

const SYNC_STATE_PK = "gmail-history-cursor";
const BACKFILL_PAGE_SIZE = 20;
const BACKFILL_QUERY = "newer_than:7d";
// Leave enough headroom to persist cursor state and return cleanly even on
// the current 90s timeout; this is a secondary guard to the 20-message cap.
const TIME_BUDGET_SAFETY_MARGIN_MS = 15_000;

/** Minimal surface poll-lambda needs from GmailClient - narrowed for easy test fakes. */
export type PollGmailClient = Pick<
  GmailClient,
  | "historyList"
  | "messagesList"
  | "messagesGet"
  | "batchModify"
  | "refreshLabelAllowlist"
>;

interface SyncState {
  pk: string;
  mode: "backfill" | "history";
  historyId?: string;
  backfillPageToken?: string;
  updatedAt: string;
}

/** Minimal surface poll-lambda needs from a DynamoDB doc client - narrowed for easy test fakes. */
export type PollDocClient = Pick<DynamoDBDocumentClient, "send">;

export interface PollLambdaDeps {
  getGmailClient: () => Promise<PollGmailClient>;
  docClient: PollDocClient;
  createClassifier: () => Classifier;
  emailsTableName: () => string;
  syncStateTableName: () => string;
  now: () => Date;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

const defaultDdbClient = new DynamoDBClient({});
const defaultDocClient = DynamoDBDocumentClient.from(defaultDdbClient, {
  marshallOptions: { removeUndefinedValues: true },
});
const defaultSecretsClient = new SecretsManagerClient({});

const defaultDeps: PollLambdaDeps = {
  getGmailClient: async () => {
    const client = await createGmailClientFromSecret(
      requireEnv("GMAIL_OAUTH_SECRET_ARN"),
      defaultSecretsClient,
      GetSecretValueCommand,
    );
    return client;
  },
  docClient: defaultDocClient,
  createClassifier: () => createDefaultClassifier(),
  emailsTableName: () => requireEnv("EMAILS_TABLE_NAME"),
  syncStateTableName: () => requireEnv("SYNC_STATE_TABLE_NAME"),
  now: () => new Date(),
};

async function getSyncState(
  deps: PollLambdaDeps,
): Promise<SyncState | undefined> {
  const result = (await deps.docClient.send(
    new GetCommand({
      TableName: deps.syncStateTableName(),
      Key: { pk: SYNC_STATE_PK },
    }),
  )) as { Item?: SyncState };
  return result.Item;
}

async function putSyncState(
  deps: PollLambdaDeps,
  state: Omit<SyncState, "pk" | "updatedAt">,
): Promise<void> {
  const item: SyncState = {
    pk: SYNC_STATE_PK,
    updatedAt: deps.now().toISOString(),
    ...state,
  };
  await deps.docClient.send(
    new PutCommand({
      TableName: deps.syncStateTableName(),
      Item: item,
    }),
  );
}

/** True if messageId already has an emails-table item (already processed). */
async function messageAlreadyProcessed(
  deps: PollLambdaDeps,
  messageId: string,
): Promise<boolean> {
  const result = (await deps.docClient.send(
    new GetCommand({
      TableName: deps.emailsTableName(),
      Key: { messageId },
      ProjectionExpression: "messageId",
    }),
  )) as { Item?: { messageId: string } };
  return Boolean(result.Item);
}

/**
 * Classifies and writes a single message: GetItem pre-check, classify,
 * single conditional PutItem, then batchModify labels. Put happens BEFORE
 * batchModify so a losing race (message processed concurrently, or a human
 * correction landed first) skips the label write too - never re-apply the
 * AI's labels over a human correction.
 *
 * Returns the message's historyId (for cursor-harvesting during backfill),
 * or undefined if the message was skipped (already processed, not inbox,
 * or lost the conditional-write race).
 */
async function processMessage(
  deps: PollLambdaDeps,
  gmail: PollGmailClient,
  labelAllowlist: ReadonlyMap<string, string>,
  classifier: Classifier,
  messageId: string,
): Promise<string | undefined> {
  if (await messageAlreadyProcessed(deps, messageId)) {
    return undefined;
  }

  const message: ParsedMessage = await gmail.messagesGet(messageId);

  // historyList() (unlike messagesList()) is not restricted to INBOX, so it
  // can surface the app's own Phase 5 drafts or the user's sent mail. Skip
  // anything not currently in the inbox.
  if (!message.labelIds.includes("INBOX")) {
    return message.historyId;
  }

  const classification = await classifier.classify({
    from: message.from,
    subject: message.subject,
    bodyText: message.bodyText,
    headers: message.headers,
  });

  const statusLabelId = labelAllowlist.get(
    responseStateLabelName(classification.responseState),
  );
  const tagLabelId = labelAllowlist.get(
    contentTagLabelName(classification.contentTag),
  );
  const addLabelIds = [statusLabelId, tagLabelId].filter((id): id is string =>
    Boolean(id),
  );

  const record: EmailRecord = {
    messageId: message.messageId,
    threadId: message.threadId,
    from: message.from,
    subject: message.subject,
    snippet: message.snippet,
    bodyText: message.bodyText,
    receivedAt: message.receivedAt,
    classification,
    appliedLabelIds: addLabelIds,
    draftCreated: false,
    isFixture: false,
    corrections: [],
  };

  try {
    await deps.docClient.send(
      new PutCommand({
        TableName: deps.emailsTableName(),
        Item: record,
        ConditionExpression: "attribute_not_exists(messageId)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Lost the race (concurrent processing or a correction already
      // landed) - safe no-op, don't touch labels.
      return message.historyId;
    }
    throw err;
  }

  if (addLabelIds.length > 0) {
    await gmail.batchModify([message.messageId], addLabelIds, []);
  } else {
    console.error(
      "poll-lambda: no label IDs resolved for classification, skipping batchModify",
      { messageId: message.messageId, classification },
    );
  }

  return message.historyId;
}

/** Processes a list of candidate message IDs, tolerating per-message failures. */
async function processMessages(
  deps: PollLambdaDeps,
  gmail: PollGmailClient,
  labelAllowlist: ReadonlyMap<string, string>,
  classifier: Classifier,
  messageIds: string[],
  context: Pick<Context, "getRemainingTimeInMillis">,
): Promise<{ harvestedHistoryId: string | undefined; allProcessed: boolean }> {
  let harvestedHistoryId: string | undefined;
  const seen = new Set<string>();

  for (const messageId of messageIds) {
    if (seen.has(messageId)) continue;
    seen.add(messageId);

    if (context.getRemainingTimeInMillis() < TIME_BUDGET_SAFETY_MARGIN_MS) {
      console.log("poll-lambda: time budget exhausted, stopping early", {
        processedSoFar: seen.size - 1,
        totalCandidates: messageIds.length,
      });
      return { harvestedHistoryId, allProcessed: false };
    }

    try {
      const historyId = await processMessage(
        deps,
        gmail,
        labelAllowlist,
        classifier,
        messageId,
      );
      if (
        historyId &&
        maxHistoryId(historyId, harvestedHistoryId) === historyId
      ) {
        harvestedHistoryId = historyId;
      }
    } catch (err) {
      console.error("poll-lambda: failed to process message, continuing", {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { harvestedHistoryId, allProcessed: true };
}

/** Compares two Gmail historyId strings numerically (they're decimal, but too large for safe number comparison). */
function maxHistoryId(a: string, b: string | undefined): string {
  if (!b) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

async function runBackfill(
  deps: PollLambdaDeps,
  gmail: PollGmailClient,
  labelAllowlist: ReadonlyMap<string, string>,
  classifier: Classifier,
  pageToken: string | undefined,
  context: Pick<Context, "getRemainingTimeInMillis">,
): Promise<void> {
  const { messageIds, nextPageToken } = await gmail.messagesList({
    query: BACKFILL_QUERY,
    pageToken,
    maxResults: BACKFILL_PAGE_SIZE,
  });

  const { harvestedHistoryId, allProcessed } = await processMessages(
    deps,
    gmail,
    labelAllowlist,
    classifier,
    messageIds,
    context,
  );

  if (!allProcessed) {
    // Didn't finish this page within budget - stay in backfill mode at the
    // same page token so the next tick resumes rather than skipping ahead.
    await putSyncState(deps, {
      mode: "backfill",
      backfillPageToken: pageToken,
    });
    return;
  }

  if (nextPageToken) {
    await putSyncState(deps, {
      mode: "backfill",
      backfillPageToken: nextPageToken,
    });
    return;
  }

  // Backfill page exhausted with no further pages. If we harvested a
  // historyId from the messages we processed, switch to history mode.
  // Otherwise (e.g. every message on this page was already processed, so
  // nothing was fetched via messagesGet) fetch one message just to obtain
  // a historyId to seed the cursor with.
  let historyId = harvestedHistoryId;
  if (!historyId && messageIds.length > 0) {
    const firstId = messageIds[0];
    if (firstId) {
      const message = await gmail.messagesGet(firstId);
      historyId = message.historyId;
    }
  }

  if (historyId) {
    await putSyncState(deps, { mode: "history", historyId });
  } else {
    // No messages at all in the lookback window - nothing to seed a cursor
    // with yet. Stay in backfill mode; the next tick will retry the same
    // (empty) query, which is cheap.
    await putSyncState(deps, {
      mode: "backfill",
      backfillPageToken: undefined,
    });
  }
}

async function runHistorySync(
  deps: PollLambdaDeps,
  gmail: PollGmailClient,
  labelAllowlist: ReadonlyMap<string, string>,
  classifier: Classifier,
  startHistoryId: string,
  context: Pick<Context, "getRemainingTimeInMillis">,
): Promise<void> {
  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;
  let finishedAllPages = false;
  let ranOutOfBudget = false;

  do {
    const { messageIdsAdded, historyId, nextPageToken } =
      await gmail.historyList({ startHistoryId, pageToken });

    if (historyId && maxHistoryId(historyId, latestHistoryId) === historyId) {
      latestHistoryId = historyId;
    }

    const { allProcessed } = await processMessages(
      deps,
      gmail,
      labelAllowlist,
      classifier,
      messageIdsAdded,
      context,
    );

    if (!allProcessed) {
      ranOutOfBudget = true;
      break;
    }

    pageToken = nextPageToken;
    if (!pageToken) {
      finishedAllPages = true;
    }
  } while (pageToken);

  if (finishedAllPages && !ranOutOfBudget) {
    await putSyncState(deps, { mode: "history", historyId: latestHistoryId });
  }
  // If we ran out of budget mid-page, leave the cursor untouched - the next
  // tick re-walks from startHistoryId, and the per-message GetItem
  // pre-check makes re-walking already-processed messages cheap.
}

export function createHandler(
  deps: PollLambdaDeps,
): (
  event: ScheduledEvent,
  context: Pick<Context, "getRemainingTimeInMillis">,
) => Promise<{ statusCode: number; body: string }> {
  return async (_event, context) => {
    let gmail: PollGmailClient;
    try {
      gmail = await deps.getGmailClient();
    } catch (err) {
      if (err instanceof GmailNotConfiguredError) {
        console.log("Gmail not configured yet - skipping poll cycle");
        return { statusCode: 200, body: "gmail not configured" };
      }
      throw err;
    }

    const labelAllowlist = await gmail.refreshLabelAllowlist();
    const classifier = deps.createClassifier();
    const syncState = await getSyncState(deps);

    try {
      if (!syncState || syncState.mode === "backfill") {
        await runBackfill(
          deps,
          gmail,
          labelAllowlist,
          classifier,
          syncState?.backfillPageToken,
          context,
        );
      } else {
        try {
          await runHistorySync(
            deps,
            gmail,
            labelAllowlist,
            classifier,
            syncState.historyId ?? "",
            context,
          );
        } catch (err) {
          if (err instanceof GmailHistoryExpiredError) {
            console.log(
              "poll-lambda: history cursor expired, falling back to backfill",
            );
            await runBackfill(
              deps,
              gmail,
              labelAllowlist,
              classifier,
              undefined,
              context,
            );
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      console.error("poll-lambda: poll cycle failed", err);
      throw err;
    }

    return { statusCode: 200, body: "ok" };
  };
}

export const handler = createHandler(defaultDeps);
