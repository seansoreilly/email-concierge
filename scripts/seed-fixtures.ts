/**
 * Loads the synthetic fixtures from shared/fixtures/emails.ts into the
 * deployed `email-concierge-emails` DynamoDB table.
 *
 * Every written item has `isFixture: true` - this is load-bearing, not
 * decorative: the DynamoDB Stream on this table is wired (via Terraform,
 * see infra/lambda.tf) to draft-lambda, filtered on
 * `eventName = INSERT AND NewImage.classification.M.responseState.S = "To Respond"`.
 * Once draft-lambda stops being a stub, it MUST check `isFixture` and skip
 * creating a real Gmail draft for fixture rows, since fixture threadIds
 * (e.g. "fixture-thread-006") do not correspond to real Gmail threads.
 *
 * Usage:
 *   pnpm --filter @email-concierge/scripts seed
 *   # or, from repo root:
 *   pnpm seed
 *
 * Table name resolution: reads process.env.EMAILS_TABLE_NAME (export this
 * from `terraform output emails_table_name` if you want to point at a
 * non-default table, e.g. in a second environment). Falls back to the
 * known literal "email-concierge-emails" (the deployed MVP table) when the
 * env var isn't set.
 *
 * Idempotent: uses PutCommand keyed on messageId, so re-running this
 * script simply overwrites the same 13 fixture rows.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { fixtureEmails } from "@email-concierge/shared/fixtures/emails.ts";
import {
  type EmailRecord,
  EmailRecord as EmailRecordSchema,
} from "@email-concierge/shared/types.ts";

const DEFAULT_TABLE_NAME = "email-concierge-emails";
const tableName = process.env.EMAILS_TABLE_NAME ?? DEFAULT_TABLE_NAME;

// Hand-assigned confidence spread so the review-queue UI's
// low-confidence-first sort has something meaningful to demonstrate.
// Cycles through the 13 fixtures rather than defaulting everything to 1.0.
const CONFIDENCE_SPREAD = [
  0.55, 0.62, 0.71, 0.78, 0.85, 0.91, 0.95, 0.58, 0.67, 0.73, 0.82, 0.88, 0.6,
];

function confidenceForIndex(index: number): number {
  const value = CONFIDENCE_SPREAD[index % CONFIDENCE_SPREAD.length];
  return value ?? 1;
}

function toEmailRecord(
  fixture: (typeof fixtureEmails)[number],
  index: number,
): EmailRecord {
  const confidence = confidenceForIndex(index);
  const priority = Math.round(
    (fixture.expected.priorityMin + fixture.expected.priorityMax) / 2,
  );

  return {
    messageId: fixture.messageId,
    threadId: fixture.threadId,
    from: fixture.from,
    subject: fixture.subject,
    snippet: fixture.snippet,
    bodyText: fixture.bodyText,
    receivedAt: fixture.receivedAt,
    classification: {
      responseState: fixture.expected.responseState,
      responseStateConfidence: confidence,
      contentTag: fixture.expected.contentTag,
      contentTagConfidence: confidence,
      priority,
      priorityConfidence: confidence,
      source: "heuristic",
    },
    appliedLabelIds: [],
    draftCreated: false,
    isFixture: true,
    corrections: [],
  };
}

async function main(): Promise<void> {
  console.log(
    `Seeding ${fixtureEmails.length} fixture emails into table "${tableName}"...`,
  );

  const ddbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
  const docClient = DynamoDBDocumentClient.from(ddbClient, {
    marshallOptions: { removeUndefinedValues: true },
  });

  let written = 0;
  for (const [index, fixture] of fixtureEmails.entries()) {
    const record = toEmailRecord(fixture, index);

    // Cheap drift check: if the schema and this transform ever disagree,
    // fail loudly here rather than writing malformed data to DynamoDB.
    const parseResult = EmailRecordSchema.safeParse(record);
    if (!parseResult.success) {
      console.error(
        `Fixture "${fixture.messageId}" failed EmailRecord validation:`,
        parseResult.error,
      );
      throw new Error(`Invalid EmailRecord for fixture ${fixture.messageId}`);
    }

    await docClient.send(
      new PutCommand({ TableName: tableName, Item: parseResult.data }),
    );
    written += 1;
    console.log(
      `  [${written}/${fixtureEmails.length}] wrote ${record.messageId} ` +
        `(responseState=${record.classification.responseState}, ` +
        `confidence=${confidenceForIndex(index)})`,
    );
  }

  console.log(
    `Done. Wrote ${written} fixture email records to "${tableName}".`,
  );
}

main().catch((error: unknown) => {
  console.error("Seed script failed:", error);
  process.exitCode = 1;
});
