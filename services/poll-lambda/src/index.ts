import type { ScheduledEvent } from "aws-lambda";

/**
 * Stub handler for the EventBridge Scheduler -> poll-lambda wiring.
 *
 * Real Gmail polling (via @email-concierge/gmail-client) and
 * classification (via @email-concierge/classifier) land in a later
 * phase. For now this proves the Lambda deploys and the scheduler can
 * invoke it successfully.
 */
export async function handler(
  _event: ScheduledEvent,
): Promise<{ statusCode: number; body: string }> {
  console.log("poll-lambda invoked", { timestamp: new Date().toISOString() });
  return { statusCode: 200, body: "ok" };
}
