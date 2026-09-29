/**
 * One-off backfill: adds `plannedAction` (shadow-mode inbox policy) to rows in the
 * `email-concierge-emails` table that predate it, computed from each row's CURRENT
 * classification (so human corrections are respected, unlike re-running the seed script,
 * which overwrites whole rows).
 *
 * Only ever SETs `plannedAction`, and only where it is absent; never touches
 * classification, corrections, labels or Gmail. Safe to re-run.
 *
 * Usage:
 *   pnpm --filter @email-concierge/scripts backfill-planned-action -- --dry-run
 *   pnpm --filter @email-concierge/scripts backfill-planned-action
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { decideAction } from "@email-concierge/classifier";
import {
  type EmailRecord,
  EmailRecord as EmailRecordSchema,
} from "@email-concierge/shared/types.ts";

const DEFAULT_TABLE_NAME = "email-concierge-emails";
const tableName = process.env.EMAILS_TABLE_NAME ?? DEFAULT_TABLE_NAME;
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  let scanned = 0;
  let updated = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey }),
    );
    lastKey = page.LastEvaluatedKey;

    for (const item of page.Items ?? []) {
      scanned += 1;
      const parsed = EmailRecordSchema.safeParse(item);
      if (!parsed.success) {
        console.error(`skip ${String(item.messageId)}: failed validation`);
        continue;
      }
      const record: EmailRecord = parsed.data;
      if (record.plannedAction) continue;

      const plannedAction = decideAction(record.classification);
      console.log(
        `${dryRun ? "[dry-run] " : ""}${record.messageId} -> ${plannedAction.action} (${plannedAction.reason})`,
      );
      if (dryRun) {
        updated += 1;
        continue;
      }
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { messageId: record.messageId },
          UpdateExpression: "SET plannedAction = :p",
          ConditionExpression:
            "attribute_exists(messageId) AND attribute_not_exists(plannedAction)",
          ExpressionAttributeValues: { ":p": plannedAction },
        }),
      );
      updated += 1;
    }
  } while (lastKey);

  console.log(
    `Done. Scanned ${scanned}, ${dryRun ? "would update" : "updated"} ${updated} in "${tableName}".`,
  );
}

main().catch((error: unknown) => {
  console.error("Backfill failed:", error);
  process.exitCode = 1;
});
