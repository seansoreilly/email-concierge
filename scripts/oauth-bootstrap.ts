import { pathToFileURL } from "node:url";
/**
 * Local, one-time, interactive script that runs Google's OAuth "Desktop app"
 * loopback consent flow and stores the resulting refresh token (plus the
 * client id/secret it was issued for) in AWS Secrets Manager, at the secret
 * Terraform already provisions (see infra/secrets.tf / infra/outputs.tf).
 *
 * This script must NEVER import "googleapis" directly - it only reaches
 * Google's OAuth flow through @email-concierge/gmail-client's
 * runLoopbackConsentFlow(), which is the sole OAuth-consent-flow surface
 * that package exposes (see the safety-boundary invariant documented at the
 * top of services/gmail-client/src/gmail-client.ts and enforced by
 * services/gmail-client/src/safety-boundary.test.ts).
 *
 * Usage:
 *   export GOOGLE_CLIENT_ID=...
 *   export GOOGLE_CLIENT_SECRET=...
 *   # optional - defaults to the deployed MVP secret name, which Secrets
 *   # Manager's GetSecretValue/PutSecretValue accept in place of a full ARN:
 *   export GMAIL_OAUTH_SECRET_ARN=$(terraform -chdir=infra output -raw gmail_oauth_secret_arn)
 *   pnpm --filter @email-concierge/scripts oauth-bootstrap
 *
 * Do NOT put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in a .env file that
 * this script reads directly - export them in your shell (or prefix the
 * command with them) so they never land in a file that could be committed.
 */
import {
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { runLoopbackConsentFlow } from "@email-concierge/gmail-client";

/** Matches infra/locals.tf's `secret_names.gmail_oauth` (`"${name_prefix}/gmail-oauth"`). */
const DEFAULT_SECRET_ID = "email-concierge/gmail-oauth";
const DEFAULT_PORT = 8080;
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export interface OAuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GMAIL_OAUTH_SECRET_ARN?: string;
}

export interface ValidatedEnv {
  clientId: string;
  clientSecret: string;
  secretId: string;
}

export class MissingEnvError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(", ")}.\nExport them before running this script, e.g.:\n  export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...\n(Create these in Google Cloud Console under APIs & Services > Credentials, as an OAuth client of type "Desktop app".)`,
    );
    this.name = "MissingEnvError";
  }
}

/**
 * Validates the environment has everything this script needs before it
 * does anything network-facing. Throws MissingEnvError (never returns a
 * partial result) so callers can't accidentally proceed with an undefined
 * clientId/clientSecret.
 */
export function validateEnv(env: OAuthEnv): ValidatedEnv {
  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }

  return {
    // The `missing` check above guarantees these are defined; non-null
    // assertion is avoided per house style by re-validating with a guard.
    clientId: requireString(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    clientSecret: requireString(
      env.GOOGLE_CLIENT_SECRET,
      "GOOGLE_CLIENT_SECRET",
    ),
    secretId: env.GMAIL_OAUTH_SECRET_ARN ?? DEFAULT_SECRET_ID,
  };
}

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new MissingEnvError([name]);
  }
  return value;
}

export interface SecretPayload {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Constructs the exact JSON shape createGmailClientFromSecret() expects. */
export function buildSecretPayload(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): SecretPayload {
  return { clientId, clientSecret, refreshToken };
}

export type ConsentFlowFn = (config: {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  port: number;
  onConsentUrl?: (url: string) => void;
}) => Promise<{ refreshToken: string; consentUrl: string }>;

export interface SecretsManagerClientLike {
  send(command: PutSecretValueCommand): Promise<unknown>;
}

export interface RunBootstrapDeps {
  env: OAuthEnv;
  consentFlow: ConsentFlowFn;
  secretsClient: SecretsManagerClientLike;
  port?: number;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

/**
 * Orchestrates the full bootstrap: validate env -> run consent flow ->
 * write the secret -> report success. Never calls process.exit itself;
 * returns an exit code so it stays trivially testable and so the real
 * entrypoint controls process lifecycle in exactly one place.
 *
 * Never logs the refresh token or client secret value - only confirms
 * success/failure - since both are security-sensitive credentials.
 */
export async function runBootstrap(deps: RunBootstrapDeps): Promise<number> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const logError =
    deps.logError ?? ((message: string) => console.error(message));
  const port = deps.port ?? DEFAULT_PORT;

  let validated: ValidatedEnv;
  try {
    validated = validateEnv(deps.env);
  } catch (err) {
    logError(errorMessage(err));
    return 1;
  }

  const { clientId, clientSecret, secretId } = validated;

  let refreshToken: string;
  try {
    log(
      `Starting Google OAuth consent flow (local redirect on http://127.0.0.1:${port})...`,
    );
    const result = await deps.consentFlow({
      clientId,
      clientSecret,
      scopes: [GMAIL_MODIFY_SCOPE],
      port,
      onConsentUrl: (url) => {
        log("\nOpen this URL in your browser to authorize:\n");
        log(`  ${url}\n`);
        log("Waiting for you to complete the consent flow in your browser...");
      },
    });
    refreshToken = result.refreshToken;
  } catch (err) {
    logError(
      `OAuth consent flow failed. This can happen if you denied consent, closed the browser tab, or the local redirect server couldn't start (e.g. port ${port} already in use).\nDetails: ${errorMessage(err)}`,
    );
    return 1;
  }

  const payload = buildSecretPayload(clientId, clientSecret, refreshToken);

  try {
    log(`Writing refresh token to Secrets Manager secret "${secretId}"...`);
    await deps.secretsClient.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify(payload),
      }),
    );
  } catch (err) {
    logError(
      `Failed to write the secret to AWS Secrets Manager. Check that your AWS credentials are configured (e.g. \`aws sts get-caller-identity\`) and that they have secretsmanager:PutSecretValue on "${secretId}".\nDetails: ${errorMessage(err)}`,
    );
    return 1;
  }

  log("Refresh token stored in Secrets Manager. Bootstrap complete.");
  return 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const secretsClient = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
  runBootstrap({
    env: process.env,
    consentFlow: runLoopbackConsentFlow,
    secretsClient,
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
