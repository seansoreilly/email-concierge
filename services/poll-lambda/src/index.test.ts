import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Classifier } from "@email-concierge/classifier";
import type { GmailClient } from "@email-concierge/gmail-client";
import { GmailHistoryExpiredError } from "@email-concierge/gmail-client";
import type { Classification } from "@email-concierge/shared";
import type { Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PollGmailClient,
  type PollLambdaDeps,
  createHandler,
  handler as realHandler,
} from "./index.ts";

const EMAILS_TABLE = "email-concierge-emails-test";
const SYNC_TABLE = "email-concierge-sync-state-test";

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  ddbMock.reset();
  secretsMock.reset();
  process.env.EMAILS_TABLE_NAME = EMAILS_TABLE;
  process.env.SYNC_STATE_TABLE_NAME = SYNC_TABLE;
  process.env.GMAIL_OAUTH_SECRET_ARN =
    "arn:aws:secretsmanager:us-east-1:151444831552:secret:email-concierge/gmail-oauth-4U522R";
});

const fullContext: Pick<Context, "getRemainingTimeInMillis"> = {
  getRemainingTimeInMillis: () => 60_000,
};

const sampleClassification: Classification = {
  responseState: "To Respond",
  responseStateConfidence: 0.9,
  contentTag: "Work",
  contentTagConfidence: 0.9,
  priority: 7,
  priorityConfidence: 0.9,
  source: "heuristic",
};

function makeParsedMessage(
  overrides: Partial<{
    messageId: string;
    historyId: string;
    labelIds: string[];
  }> = {},
) {
  return {
    messageId: overrides.messageId ?? "msg-1",
    threadId: "thread-1",
    historyId: overrides.historyId ?? "1000",
    from: "sender@example.com",
    subject: "Test subject",
    snippet: "snippet",
    bodyText: "body text",
    receivedAt: "2026-09-26T00:00:00.000Z",
    headers: {},
    labelIds: overrides.labelIds ?? ["INBOX"],
  };
}

function makeFakeGmailClient(
  overrides: Partial<PollGmailClient> = {},
): PollGmailClient {
  return {
    historyList: vi.fn().mockResolvedValue({
      messageIdsAdded: [],
      historyId: "2000",
      nextPageToken: undefined,
    }),
    messagesList: vi.fn().mockResolvedValue({
      messageIds: [],
      nextPageToken: undefined,
    }),
    messagesGet: vi.fn().mockResolvedValue(makeParsedMessage()),
    batchModify: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    unarchive: vi.fn().mockResolvedValue(undefined),
    refreshLabelAllowlist: vi.fn().mockResolvedValue(
      new Map<string, string>([
        ["Concierge/Status/To Respond", "label-status-to-respond"],
        ["Concierge/Tag/Work", "label-tag-work"],
      ]),
    ),
    ...overrides,
  } as PollGmailClient;
}

const fakeClassifier: Classifier = {
  classify: vi.fn().mockResolvedValue(sampleClassification),
};

function makeDeps(overrides: Partial<PollLambdaDeps> = {}): PollLambdaDeps {
  return {
    getGmailClient: async () => makeFakeGmailClient(),
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    createClassifier: () => fakeClassifier,
    emailsTableName: () => EMAILS_TABLE,
    syncStateTableName: () => SYNC_TABLE,
    now: () => new Date("2026-09-26T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GmailNotConfiguredError handling (safety-critical)", () => {
  it("returns a clean 200 and does not throw when the secret has no version yet (real createGmailClientFromSecret path)", async () => {
    secretsMock.on(GetSecretValueCommand).rejects(
      new ResourceNotFoundException({
        message: "Secrets Manager can't find the specified secret.",
        $metadata: {},
      }),
    );

    const result = await realHandler(
      { "detail-type": "Scheduled Event" } as never,
      fullContext,
    );

    expect(result).toEqual({ statusCode: 200, body: "gmail not configured" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("returns a clean 200 when the secret resolves with no SecretString", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: undefined });

    const result = await realHandler(
      { "detail-type": "Scheduled Event" } as never,
      fullContext,
    );

    expect(result).toEqual({ statusCode: 200, body: "gmail not configured" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("propagates via DI-injected GmailNotConfiguredError the same way", async () => {
    const { GmailNotConfiguredError } = await import(
      "@email-concierge/gmail-client"
    );
    const deps = makeDeps({
      getGmailClient: async () => {
        throw new GmailNotConfiguredError();
      },
    });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "gmail not configured" });
  });
});

describe("first-run backfill", () => {
  it("calls messagesList (not historyList) when no cursor exists", async () => {
    ddbMock
      .on(GetCommand, { TableName: SYNC_TABLE })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      messagesList: vi.fn().mockResolvedValue({
        messageIds: [],
        nextPageToken: undefined,
      }),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    expect(gmail.messagesList).toHaveBeenCalledWith(
      expect.objectContaining({ query: "newer_than:7d", maxResults: 20 }),
    );
    expect(gmail.historyList).not.toHaveBeenCalled();
  });
});

describe("subsequent-run history sync", () => {
  it("calls historyList when a cursor exists", async () => {
    ddbMock.on(GetCommand, { TableName: SYNC_TABLE }).resolves({
      Item: { pk: "gmail-history-cursor", mode: "history", historyId: "500" },
    });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      historyList: vi.fn().mockResolvedValue({
        messageIdsAdded: [],
        historyId: "600",
        nextPageToken: undefined,
      }),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    expect(gmail.historyList).toHaveBeenCalledWith(
      expect.objectContaining({ startHistoryId: "500" }),
    );
    expect(gmail.messagesList).not.toHaveBeenCalled();
  });

  it("leaves the sync-state cursor untouched when the time budget runs out mid-page", async () => {
    ddbMock.on(GetCommand, { TableName: SYNC_TABLE }).resolves({
      Item: { pk: "gmail-history-cursor", mode: "history", historyId: "500" },
    });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      historyList: vi.fn().mockResolvedValue({
        messageIdsAdded: ["msg-new"],
        historyId: "600",
        nextPageToken: undefined,
      }),
      messagesGet: vi
        .fn()
        .mockResolvedValue(makeParsedMessage({ messageId: "msg-new" })),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);
    const exhaustedContext: Pick<Context, "getRemainingTimeInMillis"> = {
      getRemainingTimeInMillis: () => 1_000,
    };

    const result = await handler({} as never, exhaustedContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    const syncStatePuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === SYNC_TABLE);
    expect(syncStatePuts).toHaveLength(0);
  });
});

describe("GmailHistoryExpiredError fallback", () => {
  it("falls back to messagesList backfill when historyList throws GmailHistoryExpiredError", async () => {
    ddbMock.on(GetCommand, { TableName: SYNC_TABLE }).resolves({
      Item: { pk: "gmail-history-cursor", mode: "history", historyId: "500" },
    });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      historyList: vi
        .fn()
        .mockRejectedValue(new GmailHistoryExpiredError("500")),
      messagesList: vi.fn().mockResolvedValue({
        messageIds: [],
        nextPageToken: undefined,
      }),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    expect(gmail.historyList).toHaveBeenCalledTimes(1);
    expect(gmail.messagesList).toHaveBeenCalledTimes(1);
  });
});

describe("new message processing", () => {
  it("classifies a new message and writes it with a single conditional PutItem carrying full classification", async () => {
    ddbMock
      .on(GetCommand, { TableName: SYNC_TABLE })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      messagesList: vi.fn().mockResolvedValue({
        messageIds: ["msg-new"],
        nextPageToken: undefined,
      }),
      messagesGet: vi
        .fn()
        .mockResolvedValue(makeParsedMessage({ messageId: "msg-new" })),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });

    const putCalls = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === EMAILS_TABLE);
    expect(putCalls).toHaveLength(1);
    const putInput = putCalls[0]?.args[0].input;
    expect(putInput?.ConditionExpression).toBe(
      "attribute_not_exists(messageId)",
    );
    expect(putInput?.Item).toMatchObject({
      messageId: "msg-new",
      classification: sampleClassification,
      appliedLabelIds: expect.arrayContaining([
        "label-status-to-respond",
        "label-tag-work",
      ]),
      isFixture: false,
      draftCreated: false,
      corrections: [],
      plannedAction: { action: "keep", reason: expect.any(String) },
    });

    expect(gmail.batchModify).toHaveBeenCalledWith(
      ["msg-new"],
      expect.arrayContaining(["label-status-to-respond", "label-tag-work"]),
      [],
    );
    // Shadow mode: labels are only ever added, never removed (no archive).
    expect(vi.mocked(gmail.batchModify).mock.calls[0]?.[2]).toEqual([]);
  });

  it("treats an already-existing message (ConditionalCheckFailedException) as a safe no-op, not an error", async () => {
    ddbMock
      .on(GetCommand, { TableName: SYNC_TABLE })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand, { TableName: EMAILS_TABLE }).rejects(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      }),
    );
    ddbMock.on(PutCommand, { TableName: SYNC_TABLE }).resolves({});

    const gmail = makeFakeGmailClient({
      messagesList: vi.fn().mockResolvedValue({
        messageIds: ["msg-existing"],
        nextPageToken: undefined,
      }),
      messagesGet: vi
        .fn()
        .mockResolvedValue(makeParsedMessage({ messageId: "msg-existing" })),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    expect(gmail.batchModify).not.toHaveBeenCalled();
  });

  it("skips an already-known message's classification/labeling via the GetItem pre-check", async () => {
    // Two candidate messages: "msg-known" already has an emails-table item
    // (pre-check hit) and should never be classified or labeled; "msg-new"
    // does not, and should be. This also exercises the harvested-historyId
    // fallback: since "msg-known" is skipped before messagesGet, the
    // historyId that seeds the sync-state cursor must come from "msg-new",
    // not from a spurious messagesGet("msg-known") call.
    ddbMock
      .on(GetCommand, { TableName: SYNC_TABLE })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE }, false)
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, {
        TableName: EMAILS_TABLE,
        Key: { messageId: "msg-known" },
      })
      .resolves({ Item: { messageId: "msg-known" } });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      messagesList: vi.fn().mockResolvedValue({
        messageIds: ["msg-known", "msg-new"],
        nextPageToken: undefined,
      }),
      messagesGet: vi
        .fn()
        .mockResolvedValue(makeParsedMessage({ messageId: "msg-new" })),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    expect(gmail.messagesGet).toHaveBeenCalledTimes(1);
    expect(gmail.messagesGet).toHaveBeenCalledWith("msg-new");
    expect(gmail.batchModify).toHaveBeenCalledWith(
      ["msg-new"],
      expect.any(Array),
      [],
    );
  });

  it("does not classify or label messages outside INBOX (e.g. the app's own drafts)", async () => {
    ddbMock.on(GetCommand, { TableName: SYNC_TABLE }).resolves({
      Item: { pk: "gmail-history-cursor", mode: "history", historyId: "500" },
    });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      historyList: vi.fn().mockResolvedValue({
        messageIdsAdded: ["msg-draft"],
        historyId: "600",
        nextPageToken: undefined,
      }),
      messagesGet: vi
        .fn()
        .mockResolvedValue(
          makeParsedMessage({ messageId: "msg-draft", labelIds: ["DRAFT"] }),
        ),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    await handler({} as never, fullContext);

    const putCalls = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === EMAILS_TABLE);
    expect(putCalls).toHaveLength(0);
    expect(gmail.batchModify).not.toHaveBeenCalled();
  });

  it("continues processing subsequent messages after one message fails", async () => {
    ddbMock
      .on(GetCommand, { TableName: SYNC_TABLE })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const gmail = makeFakeGmailClient({
      messagesList: vi.fn().mockResolvedValue({
        messageIds: ["msg-bad", "msg-good"],
        nextPageToken: undefined,
      }),
      messagesGet: vi.fn().mockImplementation((id: string) => {
        if (id === "msg-bad") {
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve(makeParsedMessage({ messageId: id }));
      }),
    });
    const deps = makeDeps({ getGmailClient: async () => gmail });
    const handler = createHandler(deps);

    const result = await handler({} as never, fullContext);

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    const putCalls = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === EMAILS_TABLE);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.args[0].input.Item).toMatchObject({
      messageId: "msg-good",
    });
  });
});

describe("archiving (feature-flagged)", () => {
  const archiveClassification: Classification = {
    responseState: "Done",
    responseStateConfidence: 0.95,
    contentTag: "Bulk/Marketing",
    contentTagConfidence: 0.95,
    priority: 2,
    priorityConfidence: 0.95,
    source: "heuristic",
  };

  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
  });

  async function run(
    enabled: boolean,
    classification: Classification,
    archive: PollGmailClient["archive"],
  ): Promise<PollGmailClient> {
    ddbMock
      .on(GetCommand, { TableName: SYNC_TABLE })
      .resolves({ Item: undefined })
      .on(GetCommand, { TableName: EMAILS_TABLE })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).callsFake(() => {
      order.push("put");
      return {};
    });
    ddbMock.on(UpdateCommand).resolves({});
    const gmail = makeFakeGmailClient({
      archive,
      messagesList: vi.fn().mockResolvedValue({
        messageIds: ["msg-a"],
        nextPageToken: undefined,
      }),
      messagesGet: vi
        .fn()
        .mockResolvedValue(makeParsedMessage({ messageId: "msg-a" })),
    });
    const deps = makeDeps({
      getGmailClient: async () => gmail,
      createClassifier: () => ({
        classify: vi.fn().mockResolvedValue(classification),
      }),
      archiveEnabled: () => enabled,
    });
    const result = await createHandler(deps)({} as never, fullContext);
    expect(result).toEqual({ statusCode: 200, body: "ok" });
    return gmail;
  }

  it("never archives when the flag is off, even if the plan says archive", async () => {
    const archive = vi.fn().mockResolvedValue(undefined);
    const gmail = await run(false, archiveClassification, archive);
    expect(gmail.archive).not.toHaveBeenCalled();
    const put = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(put?.plannedAction).toMatchObject({ action: "archive" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("archives once, after the put, when flag on and plan is archive", async () => {
    const archive = vi.fn().mockImplementation(async () => {
      order.push("archive");
    });
    const gmail = await run(true, archiveClassification, archive);
    expect(gmail.archive).toHaveBeenCalledTimes(1);
    expect(gmail.archive).toHaveBeenCalledWith(["msg-a"]);
    expect(order.indexOf("put")).toBeLessThan(order.indexOf("archive"));
    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.ExpressionAttributeValues).toEqual({ ":t": true });
  });

  it("does not archive when flag on but plan is keep", async () => {
    const archive = vi.fn().mockResolvedValue(undefined);
    const gmail = await run(true, sampleClassification, archive);
    expect(gmail.archive).not.toHaveBeenCalled();
  });

  it("keeps the stored record and does not crash when archive throws", async () => {
    const archive = vi.fn().mockRejectedValue(new Error("gmail down"));
    const gmail = await run(true, archiveClassification, archive);
    expect(gmail.archive).toHaveBeenCalledTimes(1);
    const emailPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === EMAILS_TABLE);
    expect(emailPuts).toHaveLength(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
