import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { GmailNotConfiguredError } from "@email-concierge/gmail-client";
import type { EmailRecord } from "@email-concierge/shared";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftLambdaDeps } from "./index.js";
import { handler } from "./index.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const EMAILS_TABLE = "email-concierge-emails-test";

function baseRecord(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    messageId: "msg-1",
    threadId: "thread-1",
    from: "Sarah Chen <sarah.chen@example.com>",
    subject: "Can you review the doc?",
    snippet: "Hey, wanted to check...",
    bodyText: "Hey, wanted to check if you had a chance to look.",
    receivedAt: "2026-09-22T14:30:00Z",
    classification: {
      responseState: "To Respond",
      responseStateConfidence: 0.9,
      contentTag: "Work",
      contentTagConfidence: 0.9,
      priority: 7,
      priorityConfidence: 0.9,
      source: "heuristic",
    },
    appliedLabelIds: [],
    draftCreated: false,
    isFixture: false,
    corrections: [],
    ...overrides,
  };
}

function streamEventFor(
  record: EmailRecord,
  sequenceNumber = "1",
): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: "INSERT",
        dynamodb: {
          SequenceNumber: sequenceNumber,
          NewImage: marshall(record) as never,
        },
      },
    ],
  };
}

/** Builds a deps object whose mocked methods satisfy DraftLambdaDeps structurally. */
function makeDeps(): {
  deps: DraftLambdaDeps;
  anthropicCreate: ReturnType<typeof vi.fn>;
  draftsCreate: ReturnType<typeof vi.fn>;
  getGmailClient: ReturnType<typeof vi.fn>;
} {
  const anthropicCreate = vi.fn().mockResolvedValue({
    content: [
      { type: "text", text: "Thanks, I'll take a look and get back to you." },
    ],
    stop_reason: "end_turn",
  });
  const draftsCreate = vi.fn().mockResolvedValue({ id: "draft-abc" });
  const getGmailClient = vi.fn().mockResolvedValue({ draftsCreate });

  const deps: DraftLambdaDeps = {
    getGmailClient,
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    anthropicClient: { create: anthropicCreate },
    emailsTableName: () => EMAILS_TABLE,
  };

  return { deps, anthropicCreate, draftsCreate, getGmailClient };
}

describe("draft-lambda handler", () => {
  let anthropicCreate: ReturnType<typeof vi.fn>;
  let draftsCreate: ReturnType<typeof vi.fn>;
  let getGmailClient: ReturnType<typeof vi.fn>;
  let deps: DraftLambdaDeps;

  beforeEach(() => {
    ddbMock.reset();
    ({ deps, anthropicCreate, draftsCreate, getGmailClient } = makeDeps());
  });

  it("skips fixture records before doing anything else", async () => {
    const event = streamEventFor(baseRecord({ isFixture: true }));

    const result = await handler(event, deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(getGmailClient).toHaveBeenCalled(); // client is still fetched once per batch
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(draftsCreate).not.toHaveBeenCalled();
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("returns cleanly with no error when Gmail is not configured yet", async () => {
    getGmailClient.mockRejectedValue(new GmailNotConfiguredError());
    const event = streamEventFor(baseRecord());

    const result = await handler(event, deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(draftsCreate).not.toHaveBeenCalled();
  });

  it("skips non-'To Respond' records as a defensive backstop", async () => {
    const event = streamEventFor(
      baseRecord({
        classification: {
          responseState: "FYI",
          responseStateConfidence: 0.9,
          contentTag: "Notification",
          contentTagConfidence: 0.9,
          priority: 3,
          priorityConfidence: 0.9,
          source: "heuristic",
        },
      }),
    );

    await handler(event, deps);

    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(draftsCreate).not.toHaveBeenCalled();
  });

  it("skips when draftCreated is already true in DynamoDB (re-check, not stream image)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { draftCreated: true } });
    const event = streamEventFor(baseRecord());

    await handler(event, deps);

    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(draftsCreate).not.toHaveBeenCalled();
  });

  it("generates a draft body, creates a threaded Gmail draft, and marks draftCreated", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});
    const event = streamEventFor(baseRecord());

    const result = await handler(event, deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(draftsCreate).toHaveBeenCalledWith("thread-1", expect.any(String));

    const [, rawMessage] = draftsCreate.mock.calls[0] as [string, string];
    const decoded = Buffer.from(rawMessage, "base64url").toString("utf-8");
    expect(decoded).toContain("To: sarah.chen@example.com");
    expect(decoded).toContain("Subject: Re: Can you review the doc?");
    expect(decoded).toContain("In-Reply-To: <msg-1>");
    expect(decoded).toContain("Thanks, I'll take a look");

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("does not double-prefix an already-'Re:' subject", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});
    const event = streamEventFor(
      baseRecord({ subject: "Re: Can you review the doc?" }),
    );

    await handler(event, deps);

    const [, rawMessage] = draftsCreate.mock.calls[0] as [string, string];
    const decoded = Buffer.from(rawMessage, "base64url").toString("utf-8");
    const subjectLines = decoded
      .split("\r\n")
      .filter((line) => line.startsWith("Subject:"));
    expect(subjectLines).toEqual(["Subject: Re: Can you review the doc?"]);
  });

  it("treats a lost draftCreated race (ConditionalCheckFailedException) as a safe no-op, not an error", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "lost race",
        $metadata: {},
      }),
    );
    const event = streamEventFor(baseRecord());

    const result = await handler(event, deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(draftsCreate).toHaveBeenCalledTimes(1); // draft was created; only the flag-set lost the race
  });

  it("reports a batchItemFailure (not a thrown exception) when processing a record fails", async () => {
    ddbMock.on(GetCommand).rejects(new Error("dynamo unavailable"));
    const event = streamEventFor(baseRecord(), "seq-42");

    const result = await handler(event, deps);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "seq-42" }]);
  });

  it("processes multiple records in one batch independently", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});
    const eventA = streamEventFor(
      baseRecord({ messageId: "msg-a", threadId: "thread-a" }),
    );
    const eventB = streamEventFor(
      baseRecord({ messageId: "msg-b", threadId: "thread-b" }),
    );
    const combined: DynamoDBStreamEvent = {
      Records: [...eventA.Records, ...eventB.Records],
    };

    const result = await handler(combined, deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(draftsCreate).toHaveBeenCalledTimes(2);
    expect(getGmailClient).toHaveBeenCalledTimes(1); // one client fetch per batch, not per record
  });
});
