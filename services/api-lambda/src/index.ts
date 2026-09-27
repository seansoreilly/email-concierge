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
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { GmailClient } from "@email-concierge/gmail-client";
import {
  GmailNotConfiguredError,
  createGmailClientFromSecret,
} from "@email-concierge/gmail-client";
import {
  contentTagLabelName,
  responseStateLabelName,
} from "@email-concierge/gmail-client/src/labels.ts";
import {
  type Classification,
  CorrectionRequest,
  type CorrectionRequest as CorrectionRequestType,
  type EmailRecord,
  EmailRecord as EmailRecordSchema,
} from "@email-concierge/shared";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

/**
 * Real DynamoDB-backed handler for the API Gateway HTTP API v2 -> api-lambda
 * wiring (replaces the earlier stub).
 *
 * Routing dispatches on method + path rather than `routeKey` so this works
 * whether the sibling Terraform config wires explicit route keys (e.g.
 * "GET /emails") or a single "$default" catch-all integration - confirmed
 * deployed with explicit route keys ("GET /emails",
 * "POST /emails/{messageId}/correction") behind a Cognito JWT authorizer.
 */

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});

const CORRECTION_PATH_PATTERN = /^\/emails\/([^/]+)\/correction$/;

/** Minimal surface the correction handler needs from GmailClient - narrowed for easy test fakes. */
type CorrectionGmailClient = Pick<
  GmailClient,
  "batchModify" | "refreshLabelAllowlist"
>;

/**
 * Sourced from AWS Secrets Manager by default; overridable in tests so no
 * live Secrets Manager/Gmail call is ever made during `pnpm test`.
 */
let getGmailClient: () => Promise<CorrectionGmailClient> = async () => {
  const secretArn = process.env.GMAIL_OAUTH_SECRET_ARN;
  if (!secretArn) {
    throw new GmailNotConfiguredError();
  }
  return createGmailClientFromSecret(
    secretArn,
    secretsClient,
    GetSecretValueCommand,
  );
};

/** Test-only seam - never called from production code. */
export function __setGmailClientFactoryForTests(
  factory: typeof getGmailClient,
): void {
  getGmailClient = factory;
}

function jsonResponse(
  statusCode: number,
  payload: unknown,
): APIGatewayProxyResultV2 {
  return { statusCode, body: JSON.stringify(payload) };
}

function requireTableName(): string {
  const tableName = process.env.EMAILS_TABLE_NAME;
  if (!tableName) {
    throw new Error("EMAILS_TABLE_NAME environment variable is not set");
  }
  return tableName;
}

async function handleListEmails(): Promise<APIGatewayProxyResultV2> {
  try {
    const result = await docClient.send(
      new ScanCommand({ TableName: requireTableName() }),
    );
    const items = result.Items ?? [];
    const emails: EmailRecord[] = [];
    for (const item of items) {
      const parsed = EmailRecordSchema.safeParse(item);
      if (parsed.success) {
        emails.push(parsed.data);
      } else {
        console.warn(
          "Skipping malformed email record from Scan",
          "messageId" in item ? item.messageId : "<unknown>",
          parsed.error,
        );
      }
    }
    return jsonResponse(200, emails);
  } catch (error) {
    console.error("Failed to scan emails table", error);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

function extractMessageId(event: APIGatewayProxyEventV2): string | undefined {
  const fromPathParams = event.pathParameters?.messageId;
  if (fromPathParams) {
    return decodeURIComponent(fromPathParams);
  }
  const match = event.requestContext.http.path.match(CORRECTION_PATH_PATTERN);
  const captured = match?.[1];
  return captured ? decodeURIComponent(captured) : undefined;
}

function decodeBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    return "";
  }
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

/**
 * Best-effort sync of a human correction back to Gmail via batchModify:
 * removes the labels implied by the previous classification and adds the
 * labels implied by the corrected one. Never throws - any failure (Gmail
 * not configured yet, a transient API error, etc.) is logged and swallowed,
 * since the DynamoDB update (the primary source of truth) has already
 * succeeded by the time this is called.
 */
async function syncCorrectionToGmail(
  messageId: string,
  previous: Pick<Classification, "responseState" | "contentTag">,
  corrected: CorrectionRequestType,
): Promise<void> {
  try {
    const gmail = await getGmailClient();
    const labelAllowlist = await gmail.refreshLabelAllowlist();

    const previousLabelIds = [
      labelAllowlist.get(responseStateLabelName(previous.responseState)),
      labelAllowlist.get(contentTagLabelName(previous.contentTag)),
    ].filter((id): id is string => Boolean(id));

    const correctedLabelIds = [
      labelAllowlist.get(responseStateLabelName(corrected.responseState)),
      labelAllowlist.get(contentTagLabelName(corrected.contentTag)),
    ].filter((id): id is string => Boolean(id));

    if (correctedLabelIds.length === 0 && previousLabelIds.length === 0) {
      return;
    }

    await gmail.batchModify(
      [messageId],
      correctedLabelIds,
      previousLabelIds.filter((id) => !correctedLabelIds.includes(id)),
    );
  } catch (error) {
    if (error instanceof GmailNotConfiguredError) {
      console.log(
        "Gmail not configured yet - skipping correction sync",
        messageId,
      );
      return;
    }
    console.error(
      "Failed to sync correction to Gmail (DynamoDB update already succeeded)",
      messageId,
      error,
    );
  }
}

async function handleCorrection(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const messageId = extractMessageId(event);
  if (!messageId) {
    return jsonResponse(400, { error: "Missing messageId in path" });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(decodeBody(event));
  } catch {
    return jsonResponse(400, { error: "Request body must be valid JSON" });
  }

  const correctionResult = CorrectionRequest.safeParse(parsedBody);
  if (!correctionResult.success) {
    return jsonResponse(400, {
      error: "Invalid correction request body",
      details: correctionResult.error.flatten(),
    });
  }
  const correction = correctionResult.data;

  try {
    const table = requireTableName();

    const existing = await docClient.send(
      new GetCommand({ TableName: table, Key: { messageId } }),
    );
    if (!existing.Item) {
      return jsonResponse(404, { error: "Email not found" });
    }

    const existingParsed = EmailRecordSchema.safeParse(existing.Item);
    if (!existingParsed.success) {
      console.error(
        "Existing record failed EmailRecord validation",
        messageId,
        existingParsed.error,
      );
      return jsonResponse(500, { error: "Internal server error" });
    }

    const correctedAt = new Date().toISOString();
    const correctionRecord = {
      messageId,
      correctedAt,
      previous: {
        responseState: existingParsed.data.classification.responseState,
        contentTag: existingParsed.data.classification.contentTag,
        priority: existingParsed.data.classification.priority,
      },
      corrected: correction,
    };

    const updateResult = await docClient.send(
      new UpdateCommand({
        TableName: table,
        Key: { messageId },
        ConditionExpression: "attribute_exists(#mid)",
        UpdateExpression:
          "SET #c.#rs = :rs, #c.#ct = :ct, #c.#pr = :pr, " +
          "#c.#rsc = :fullConfidence, #c.#ctc = :fullConfidence, #c.#prc = :fullConfidence, " +
          "#c.#src = :human, " +
          "#corr = list_append(if_not_exists(#corr, :emptyList), :newCorrection)",
        ExpressionAttributeNames: {
          "#mid": "messageId",
          "#c": "classification",
          "#rs": "responseState",
          "#ct": "contentTag",
          "#pr": "priority",
          "#rsc": "responseStateConfidence",
          "#ctc": "contentTagConfidence",
          "#prc": "priorityConfidence",
          "#src": "source",
          "#corr": "corrections",
        },
        ExpressionAttributeValues: {
          ":rs": correction.responseState,
          ":ct": correction.contentTag,
          ":pr": correction.priority,
          ":fullConfidence": 1,
          ":human": "human",
          ":emptyList": [],
          ":newCorrection": [correctionRecord],
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    const updatedParsed = EmailRecordSchema.safeParse(updateResult.Attributes);
    if (!updatedParsed.success) {
      console.error(
        "Updated record failed EmailRecord validation",
        messageId,
        updatedParsed.error,
      );
      return jsonResponse(500, { error: "Internal server error" });
    }

    // Best-effort sync back to Gmail: DynamoDB is the primary store for a
    // correction (already committed above), so a Gmail-side failure here is
    // logged but must never fail the overall request - the human's
    // correction is already durable regardless of Gmail's state.
    if (!updatedParsed.data.isFixture) {
      await syncCorrectionToGmail(
        messageId,
        existingParsed.data.classification,
        correction,
      );
    }

    return jsonResponse(200, updatedParsed.data);
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return jsonResponse(404, { error: "Email not found" });
    }
    console.error("Failed to apply correction", error);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  if (method === "GET" && path === "/emails") {
    return handleListEmails();
  }

  if (method === "POST" && CORRECTION_PATH_PATTERN.test(path)) {
    return handleCorrection(event);
  }

  return jsonResponse(404, { error: "Not Found" });
}
