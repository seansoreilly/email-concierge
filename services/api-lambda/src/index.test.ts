import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GmailNotConfiguredError } from "@email-concierge/gmail-client";
import type { EmailRecord } from "@email-concierge/shared";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiLambdaDeps, createHandler } from "./index.ts";

const ddbMock = mockClient(DynamoDBDocumentClient);
const testDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Builds a handler wired to the mocked DynamoDBDocumentClient (via
 * aws-sdk-client-mock's prototype patch) and a test EMAILS_TABLE_NAME, with
 * an overridable Gmail client factory. Defaults to the same
 * GmailNotConfiguredError silent-skip behavior as production when unset.
 */
function makeHandler(
  getGmailClient: ApiLambdaDeps["getGmailClient"] = async () => {
    throw new GmailNotConfiguredError();
  },
) {
  return createHandler({
    getGmailClient,
    docClient: testDocClient,
    emailsTableName: () => "email-concierge-emails-test",
  });
}

// The handler always returns the structured object form (never the bare
// string form of APIGatewayProxyResultV2), but the type is a union - this
// helper narrows it for tests without resorting to a non-null assertion.
function expectStructuredResult(result: APIGatewayProxyResultV2): {
  statusCode: number;
  body: string;
} {
  if (typeof result === "string") {
    throw new Error("Expected a structured APIGatewayProxyResultV2");
  }
  return { statusCode: result.statusCode ?? 0, body: result.body ?? "" };
}

beforeEach(() => {
  ddbMock.reset();
});

/**
 * Builds an APIGatewayProxyEventV2 for a route, deriving the repeated
 * requestContext (account/api ids, http block, routeKey, stage, timestamps)
 * from just the method, path, and routeKey - the fields tests actually vary.
 */
function makeEvent(
  options: {
    routeKey?: string;
    path?: string;
    method?: string;
    body?: string;
    pathParameters?: Record<string, string>;
  } = {},
): APIGatewayProxyEventV2 {
  const routeKey = options.routeKey ?? "GET /emails";
  const path = options.path ?? "/emails";
  const method = options.method ?? "GET";
  return {
    version: "2.0",
    routeKey,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    pathParameters: options.pathParameters,
    body: options.body,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "api-id.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "api-id",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "request-id",
      routeKey,
      stage: "$default",
      time: "26/Sep/2026:00:00:00 +0000",
      timeEpoch: 1700000000000,
    },
    isBase64Encoded: false,
  };
}

const sampleEmail: EmailRecord = {
  messageId: "fixture-001",
  threadId: "fixture-thread-001",
  from: "sarah.chen@example.com",
  subject: "Can you review the Q3 roadmap doc before Friday?",
  snippet: "Hey, wanted to check if you had a chance to look at the roadmap...",
  bodyText: "Hey, wanted to check if you had a chance to look...",
  receivedAt: "2026-09-22T14:30:00Z",
  classification: {
    responseState: "To Respond",
    responseStateConfidence: 0.8,
    contentTag: "Work",
    contentTagConfidence: 0.8,
    priority: 7,
    priorityConfidence: 0.8,
    source: "heuristic",
  },
  appliedLabelIds: [],
  draftCreated: false,
  isFixture: true,
  corrections: [],
};

describe("GET /emails", () => {
  it("returns parsed records from a mocked Scan response", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [sampleEmail] });

    const { statusCode, body: rawBody } = expectStructuredResult(
      await makeHandler()(makeEvent()),
    );

    expect(statusCode).toBe(200);
    const body = JSON.parse(rawBody) as EmailRecord[];
    expect(body).toHaveLength(1);
    expect(body[0]?.messageId).toBe("fixture-001");
  });

  it("filters out malformed records and logs a warning", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [sampleEmail, { messageId: "broken-item" }],
    });

    const { statusCode, body: rawBody } = expectStructuredResult(
      await makeHandler()(makeEvent()),
    );

    expect(statusCode).toBe(200);
    const body = JSON.parse(rawBody) as EmailRecord[];
    expect(body).toHaveLength(1);
  });
});

describe("POST /emails/{messageId}/correction", () => {
  const correctionEvent = (
    body: string,
    messageId = "fixture-001",
  ): APIGatewayProxyEventV2 =>
    makeEvent({
      routeKey: "POST /emails/{messageId}/correction",
      path: `/emails/${messageId}/correction`,
      method: "POST",
      pathParameters: { messageId },
      body,
    });

  it("updates and returns the record for a valid body", async () => {
    ddbMock.on(GetCommand).resolves({ Item: sampleEmail });
    const updatedRecord: EmailRecord = {
      ...sampleEmail,
      classification: {
        ...sampleEmail.classification,
        responseState: "Done",
        contentTag: "Work",
        priority: 3,
        responseStateConfidence: 1,
        contentTagConfidence: 1,
        priorityConfidence: 1,
        source: "human",
      },
      corrections: [
        {
          messageId: "fixture-001",
          correctedAt: "2026-09-26T00:00:00.000Z",
          previous: {
            responseState: "To Respond",
            contentTag: "Work",
            priority: 7,
          },
          corrected: { responseState: "Done", contentTag: "Work", priority: 3 },
        },
      ],
    };
    ddbMock.on(UpdateCommand).resolves({ Attributes: updatedRecord });

    const { statusCode, body: rawBody } = expectStructuredResult(
      await makeHandler()(
        correctionEvent(
          JSON.stringify({
            responseState: "Done",
            contentTag: "Work",
            priority: 3,
          }),
        ),
      ),
    );

    expect(statusCode).toBe(200);
    const body = JSON.parse(rawBody) as EmailRecord;
    expect(body.classification.source).toBe("human");
    expect(body.classification.responseState).toBe("Done");

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall?.args[0].input.ExpressionAttributeValues).toMatchObject({
      ":classification": {
        responseState: "Done",
        contentTag: "Work",
        priority: 3,
        responseStateConfidence: 1,
        contentTagConfidence: 1,
        priorityConfidence: 1,
        source: "human",
      },
    });
  });

  it("returns 400 for an invalid body", async () => {
    const { statusCode } = expectStructuredResult(
      await makeHandler()(
        correctionEvent(JSON.stringify({ responseState: "Not A Real State" })),
      ),
    );

    expect(statusCode).toBe(400);
  });

  it("returns 400 for unparseable JSON", async () => {
    const { statusCode } = expectStructuredResult(
      await makeHandler()(correctionEvent("not json")),
    );

    expect(statusCode).toBe(400);
  });

  it("returns 404 when the record does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const { statusCode } = expectStructuredResult(
      await makeHandler()(
        correctionEvent(
          JSON.stringify({
            responseState: "Done",
            contentTag: "Work",
            priority: 3,
          }),
          "missing-id",
        ),
      ),
    );

    expect(statusCode).toBe(404);
  });
});

describe("Gmail sync on correction", () => {
  const nonFixtureEmail: EmailRecord = {
    ...sampleEmail,
    messageId: "real-001",
    isFixture: false,
  };

  const updatedNonFixtureRecord: EmailRecord = {
    ...nonFixtureEmail,
    classification: {
      ...nonFixtureEmail.classification,
      responseState: "Done",
      contentTag: "Work",
      priority: 3,
      responseStateConfidence: 1,
      contentTagConfidence: 1,
      priorityConfidence: 1,
      source: "human",
    },
    corrections: [
      {
        messageId: "real-001",
        correctedAt: "2026-09-26T00:00:00.000Z",
        previous: {
          responseState: "To Respond",
          contentTag: "Work",
          priority: 7,
        },
        corrected: { responseState: "Done", contentTag: "Work", priority: 3 },
      },
    ],
  };

  const correctionEventFor = (messageId: string): APIGatewayProxyEventV2 =>
    makeEvent({
      routeKey: "POST /emails/{messageId}/correction",
      path: `/emails/${messageId}/correction`,
      method: "POST",
      pathParameters: { messageId },
      body: JSON.stringify({
        responseState: "Done",
        contentTag: "Work",
        priority: 3,
      }),
    });

  function makeFakeGmailClient() {
    return {
      batchModify: vi.fn().mockResolvedValue(undefined),
      refreshLabelAllowlist: vi.fn().mockResolvedValue(
        new Map<string, string>([
          ["Concierge/Status/To Respond", "label-status-to-respond"],
          ["Concierge/Status/Done", "label-status-done"],
          ["Concierge/Tag/Work", "label-tag-work"],
        ]),
      ),
    };
  }

  it("calls batchModify for a correction on a non-fixture record", async () => {
    ddbMock.on(GetCommand).resolves({ Item: nonFixtureEmail });
    ddbMock.on(UpdateCommand).resolves({ Attributes: updatedNonFixtureRecord });

    const gmail = makeFakeGmailClient();

    const { statusCode } = expectStructuredResult(
      await makeHandler(async () => gmail)(correctionEventFor("real-001")),
    );

    expect(statusCode).toBe(200);
    // contentTag stays "Work" before and after the correction, so its label
    // is in both the add and previous sets - it must be added (harmless if
    // already applied) but NOT removed, since only responseState actually
    // changed (To Respond -> Done).
    expect(gmail.batchModify).toHaveBeenCalledWith(
      ["real-001"],
      expect.arrayContaining(["label-status-done", "label-tag-work"]),
      ["label-status-to-respond"],
    );
  });

  it("does NOT call any Gmail method for a correction on a fixture record", async () => {
    ddbMock.on(GetCommand).resolves({ Item: sampleEmail }); // sampleEmail has isFixture: true
    const updatedFixtureRecord: EmailRecord = {
      ...sampleEmail,
      classification: {
        ...sampleEmail.classification,
        responseState: "Done",
        source: "human",
      },
    };
    ddbMock.on(UpdateCommand).resolves({ Attributes: updatedFixtureRecord });

    const gmail = makeFakeGmailClient();

    const { statusCode } = expectStructuredResult(
      await makeHandler(async () => gmail)(correctionEventFor("fixture-001")),
    );

    expect(statusCode).toBe(200);
    expect(gmail.batchModify).not.toHaveBeenCalled();
    expect(gmail.refreshLabelAllowlist).not.toHaveBeenCalled();
  });

  it("still returns the successful DynamoDB-updated record when the Gmail sync fails", async () => {
    ddbMock.on(GetCommand).resolves({ Item: nonFixtureEmail });
    ddbMock.on(UpdateCommand).resolves({ Attributes: updatedNonFixtureRecord });

    const { statusCode, body: rawBody } = expectStructuredResult(
      await makeHandler(async () => {
        throw new Error("Gmail API is down");
      })(correctionEventFor("real-001")),
    );

    expect(statusCode).toBe(200);
    const body = JSON.parse(rawBody) as EmailRecord;
    expect(body.classification.responseState).toBe("Done");
  });

  it("skips Gmail sync silently when Gmail is not configured (GmailNotConfiguredError)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: nonFixtureEmail });
    ddbMock.on(UpdateCommand).resolves({ Attributes: updatedNonFixtureRecord });
    // makeHandler()'s default factory throws GmailNotConfiguredError, same
    // as production behavior when GMAIL_OAUTH_SECRET_ARN is unset.

    const { statusCode } = expectStructuredResult(
      await makeHandler()(correctionEventFor("real-001")),
    );

    expect(statusCode).toBe(200);
  });
});

describe("unmatched routes", () => {
  it("returns 404 for unknown paths", async () => {
    const { statusCode } = expectStructuredResult(
      await makeHandler()(
        makeEvent({
          routeKey: "$default",
          path: "/unknown",
        }),
      ),
    );

    expect(statusCode).toBe(404);
  });
});
