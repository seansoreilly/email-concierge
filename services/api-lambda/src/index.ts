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
import { decideAction } from "@email-concierge/classifier";
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
 * Routing dispatches on `event.routeKey`, matching the explicit route keys
 * Terraform wires in infra/apigateway.tf ("GET /emails" and
 * "POST /emails/{messageId}/correction") behind a Cognito JWT authorizer -
 * there is no "$default" catch-all deployment, so no fallback routing or
 * path-regex extraction is needed.
 */

const LIST_EMAILS_ROUTE = "GET /emails";
const SUBMIT_CORRECTION_ROUTE = "POST /emails/{messageId}/correction";

/** Minimal surface the correction handler needs from GmailClient - narrowed for easy test fakes. */
type CorrectionGmailClient = Pick<
  GmailClient,
  "batchModify" | "archive" | "unarchive" | "refreshLabelAllowlist"
>;

export interface ApiLambdaDeps {
  getGmailClient: () => Promise<CorrectionGmailClient>;
  docClient: DynamoDBDocumentClient;
  emailsTableName: () => string;
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

const defaultDeps: ApiLambdaDeps = {
  // Sourced from AWS Secrets Manager by default. Deliberately throws
  // GmailNotConfiguredError (not a generic Error) when the secret ARN isn't
  // set yet, so syncCorrectionToGmail's silent-skip branch applies instead
  // of logging it as a real failure.
  getGmailClient: async () => {
    const secretArn = process.env.GMAIL_OAUTH_SECRET_ARN;
    if (!secretArn) {
      throw new GmailNotConfiguredError();
    }
    return createGmailClientFromSecret(
      secretArn,
      defaultSecretsClient,
      GetSecretValueCommand,
    );
  },
  docClient: defaultDocClient,
  emailsTableName: () => requireEnv("EMAILS_TABLE_NAME"),
};

function jsonResponse(
  statusCode: number,
  payload: unknown,
): APIGatewayProxyResultV2 {
  return { statusCode, body: JSON.stringify(payload) };
}

async function handleListEmails(
  deps: ApiLambdaDeps,
): Promise<APIGatewayProxyResultV2> {
  try {
    const result = await deps.docClient.send(
      new ScanCommand({ TableName: deps.emailsTableName() }),
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

function decodeBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    return "";
  }
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

/**
 * Resolves the Gmail label IDs implied by a classification's
 * responseState/contentTag, filtering out any that aren't in the current
 * label allowlist. Shared by both the previous and corrected classification
 * lookups in syncCorrectionToGmail.
 */
function resolveLabelIdsForClassification(
  labelAllowlist: ReadonlyMap<string, string>,
  classification: Pick<Classification, "responseState" | "contentTag">,
): string[] {
  return [
    labelAllowlist.get(responseStateLabelName(classification.responseState)),
    labelAllowlist.get(contentTagLabelName(classification.contentTag)),
  ].filter((id): id is string => Boolean(id));
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
  deps: ApiLambdaDeps,
  messageId: string,
  previous: Pick<Classification, "responseState" | "contentTag">,
  corrected: CorrectionRequestType,
): Promise<void> {
  try {
    const gmail = await deps.getGmailClient();
    const labelAllowlist = await gmail.refreshLabelAllowlist();

    const previousLabelIds = resolveLabelIdsForClassification(
      labelAllowlist,
      previous,
    );
    const correctedLabelIds = resolveLabelIdsForClassification(
      labelAllowlist,
      corrected,
    );

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

/**
 * Best-effort un-archive after a human correction: if the message was
 * archived by the app and the corrected classification would not be archived
 * by the policy, put it back in the inbox and clear the archived flag. Never
 * throws.
 */
async function maybeUnarchive(
  deps: ApiLambdaDeps,
  messageId: string,
  archived: boolean | undefined,
  corrected: Classification,
): Promise<boolean> {
  if (archived !== true) {
    return false;
  }
  const keepInInbox =
    corrected.responseState === "To Respond" ||
    corrected.responseState === "Awaiting Reply" ||
    decideAction(corrected).action === "keep";
  if (!keepInInbox) {
    return false;
  }
  try {
    const gmail = await deps.getGmailClient();
    await gmail.unarchive([messageId]);
    await deps.docClient.send(
      new UpdateCommand({
        TableName: deps.emailsTableName(),
        Key: { messageId },
        UpdateExpression: "SET archived = :f",
        ExpressionAttributeValues: { ":f": false },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof GmailNotConfiguredError) {
      console.log("Gmail not configured yet - skipping unarchive", messageId);
      return false;
    }
    console.error(
      "Failed to unarchive after correction (DynamoDB update already succeeded)",
      messageId,
      error,
    );
    return false;
  }
}

async function handleCorrection(
  deps: ApiLambdaDeps,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const messageId = event.pathParameters?.messageId;
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
    const table = deps.emailsTableName();

    const existing = await deps.docClient.send(
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

    const correctedClassification: Classification = {
      ...correction,
      responseStateConfidence: 1,
      contentTagConfidence: 1,
      priorityConfidence: 1,
      source: "human",
    };

    const updateResult = await deps.docClient.send(
      new UpdateCommand({
        TableName: table,
        Key: { messageId },
        ConditionExpression: "attribute_exists(#mid)",
        UpdateExpression:
          "SET #c = :classification, " +
          "#corr = list_append(if_not_exists(#corr, :emptyList), :newCorrection)",
        ExpressionAttributeNames: {
          "#mid": "messageId",
          "#c": "classification",
          "#corr": "corrections",
        },
        ExpressionAttributeValues: {
          ":classification": correctedClassification,
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
        deps,
        messageId,
        existingParsed.data.classification,
        correction,
      );
      const unarchived = await maybeUnarchive(
        deps,
        messageId,
        updatedParsed.data.archived,
        updatedParsed.data.classification,
      );
      if (unarchived) {
        return jsonResponse(200, { ...updatedParsed.data, archived: false });
      }
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

/**
 * Lambda's Node.js runtime always invokes the exported handler with
 * (event, context) - a default parameter on a second `deps` argument never
 * fires, since `context` is always a real, truthy value. createHandler is
 * the standard fix (see draft-lambda for the same pattern): bind deps via
 * closure, export a zero-config `handler` for Lambda, and let tests call
 * createHandler(fakeDeps) directly.
 */
export function createHandler(
  deps: ApiLambdaDeps,
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2> {
  return async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyResultV2> => {
    switch (event.routeKey) {
      case LIST_EMAILS_ROUTE:
        return handleListEmails(deps);
      case SUBMIT_CORRECTION_ROUTE:
        return handleCorrection(deps, event);
      default:
        return jsonResponse(404, { error: "Not Found" });
    }
  };
}

export const handler = createHandler(defaultDeps);
