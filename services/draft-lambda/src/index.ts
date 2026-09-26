import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";

/**
 * Stub handler for the DynamoDB Streams -> draft-lambda wiring.
 *
 * Real draft-creation logic (via @email-concierge/gmail-client) lands
 * in a later phase. For now this proves the Lambda deploys and the
 * stream event source mapping can invoke it successfully.
 *
 * Returns an empty `batchItemFailures` array, the safe default shape
 * for a stream mapping with `functionResponseTypes: ["ReportBatchItemFailures"]`
 * enabled -- reporting no failures. If partial-batch-failure reporting
 * is not enabled on the event source mapping, this return value is
 * simply ignored by the runtime.
 */
export async function handler(
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> {
  console.log("draft-lambda invoked", { recordCount: event.Records.length });
  return { batchItemFailures: [] };
}
