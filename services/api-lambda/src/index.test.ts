import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EmailRecord } from "@email-concierge/shared";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "./index.ts";

const ddbMock = mockClient(DynamoDBDocumentClient);

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
  process.env.EMAILS_TABLE_NAME = "email-concierge-emails-test";
});

function makeEvent(
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/emails",
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "api-id.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "api-id",
      http: {
        method: "GET",
        path: "/emails",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "26/Sep/2026:00:00:00 +0000",
      timeEpoch: 1700000000000,
    },
    isBase64Encoded: false,
    ...overrides,
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
      await handler(makeEvent()),
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
      await handler(makeEvent()),
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
      rawPath: `/emails/${messageId}/correction`,
      pathParameters: { messageId },
      body,
      requestContext: {
        accountId: "123456789012",
        apiId: "api-id",
        domainName: "api-id.execute-api.us-east-1.amazonaws.com",
        domainPrefix: "api-id",
        http: {
          method: "POST",
          path: `/emails/${messageId}/correction`,
          protocol: "HTTP/1.1",
          sourceIp: "127.0.0.1",
          userAgent: "vitest",
        },
        requestId: "request-id",
        routeKey: "$default",
        stage: "$default",
        time: "26/Sep/2026:00:00:00 +0000",
        timeEpoch: 1700000000000,
      },
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
      await handler(
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
      ":rs": "Done",
      ":ct": "Work",
      ":pr": 3,
      ":fullConfidence": 1,
    });
  });

  it("returns 400 for an invalid body", async () => {
    const { statusCode } = expectStructuredResult(
      await handler(
        correctionEvent(JSON.stringify({ responseState: "Not A Real State" })),
      ),
    );

    expect(statusCode).toBe(400);
  });

  it("returns 400 for unparseable JSON", async () => {
    const { statusCode } = expectStructuredResult(
      await handler(correctionEvent("not json")),
    );

    expect(statusCode).toBe(400);
  });

  it("returns 404 when the record does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const { statusCode } = expectStructuredResult(
      await handler(
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

describe("unmatched routes", () => {
  it("returns 404 for unknown paths", async () => {
    const { statusCode } = expectStructuredResult(
      await handler(
        makeEvent({
          rawPath: "/unknown",
          requestContext: {
            accountId: "123456789012",
            apiId: "api-id",
            domainName: "api-id.execute-api.us-east-1.amazonaws.com",
            domainPrefix: "api-id",
            http: {
              method: "GET",
              path: "/unknown",
              protocol: "HTTP/1.1",
              sourceIp: "127.0.0.1",
              userAgent: "vitest",
            },
            requestId: "request-id",
            routeKey: "$default",
            stage: "$default",
            time: "26/Sep/2026:00:00:00 +0000",
            timeEpoch: 1700000000000,
          },
        }),
      ),
    );

    expect(statusCode).toBe(404);
  });
});
