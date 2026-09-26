import type { EmailRecord } from "@email-concierge/shared";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

/**
 * Stub handler for the API Gateway HTTP API v2 -> api-lambda wiring.
 *
 * Real DynamoDB-backed queries and correction persistence (via
 * @email-concierge/gmail-client / a DynamoDB client) land in a later
 * phase. For now this proves the Lambda deploys, routes dispatch
 * correctly, and the response shapes match what the frontend expects.
 *
 * Routing dispatches on method + path rather than `routeKey` so this
 * works whether the sibling Terraform config wires explicit route keys
 * (e.g. "GET /emails") or a single "$default" catch-all integration.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  if (method === "GET" && path === "/emails") {
    const emails: EmailRecord[] = [];
    return { statusCode: 200, body: JSON.stringify(emails) };
  }

  if (method === "POST" && /^\/emails\/[^/]+\/correction$/.test(path)) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 404, body: JSON.stringify({ error: "Not Found" }) };
}
