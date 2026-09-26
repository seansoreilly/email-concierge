import {
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConsentFlowFn,
  MissingEnvError,
  type SecretsManagerClientLike,
  buildSecretPayload,
  runBootstrap,
  validateEnv,
} from "./oauth-bootstrap.ts";

const FAKE_REFRESH_TOKEN = "fake-refresh-token-do-not-leak-1234567890";

function makeConsentFlow(
  overrides: Partial<{
    refreshToken: string;
    consentUrl: string;
    reject: Error;
  }> = {},
): ConsentFlowFn {
  return vi.fn(async (config) => {
    config.onConsentUrl?.(
      overrides.consentUrl ??
        "https://accounts.google.com/o/oauth2/fake-consent-url",
    );
    if (overrides.reject) {
      throw overrides.reject;
    }
    return {
      refreshToken: overrides.refreshToken ?? FAKE_REFRESH_TOKEN,
      consentUrl:
        overrides.consentUrl ??
        "https://accounts.google.com/o/oauth2/fake-consent-url",
    };
  });
}

function makeLogCapture(): {
  log: (message: string) => void;
  logError: (message: string) => void;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (message: string) => logs.push(message),
    logError: (message: string) => errors.push(message),
    logs,
    errors,
  };
}

describe("validateEnv", () => {
  it("returns clientId/clientSecret/secretId when both required vars are set", () => {
    const result = validateEnv({
      GOOGLE_CLIENT_ID: "client-id-123",
      GOOGLE_CLIENT_SECRET: "client-secret-456",
    });
    expect(result).toEqual({
      clientId: "client-id-123",
      clientSecret: "client-secret-456",
      secretId: "email-concierge/gmail-oauth",
    });
  });

  it("uses GMAIL_OAUTH_SECRET_ARN when provided", () => {
    const result = validateEnv({
      GOOGLE_CLIENT_ID: "client-id-123",
      GOOGLE_CLIENT_SECRET: "client-secret-456",
      GMAIL_OAUTH_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123:secret:foo",
    });
    expect(result.secretId).toBe(
      "arn:aws:secretsmanager:us-east-1:123:secret:foo",
    );
  });

  it("throws MissingEnvError when GOOGLE_CLIENT_ID is missing", () => {
    expect(() =>
      validateEnv({ GOOGLE_CLIENT_SECRET: "client-secret-456" }),
    ).toThrow(MissingEnvError);
  });

  it("throws MissingEnvError when GOOGLE_CLIENT_SECRET is missing", () => {
    expect(() => validateEnv({ GOOGLE_CLIENT_ID: "client-id-123" })).toThrow(
      MissingEnvError,
    );
  });

  it("lists both missing vars when neither is set", () => {
    try {
      validateEnv({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as Error).message).toContain("GOOGLE_CLIENT_ID");
      expect((err as Error).message).toContain("GOOGLE_CLIENT_SECRET");
    }
  });
});

describe("buildSecretPayload", () => {
  it("constructs the exact {clientId, clientSecret, refreshToken} shape", () => {
    expect(buildSecretPayload("id", "secret", "refresh")).toEqual({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
  });
});

describe("runBootstrap", () => {
  // Same aws-sdk-client-mock pattern services/api-lambda/src/index.test.ts
  // uses for DynamoDBDocumentClient - mocks the real AWS SDK v3 client so no
  // live network/AWS calls happen, while still exercising the real
  // PutSecretValueCommand construction and input shape.
  const smMock = mockClient(SecretsManagerClient);
  const secretsClient: SecretsManagerClientLike = new SecretsManagerClient({});

  beforeEach(() => {
    smMock.reset();
  });

  it("does not proceed and reports a clear error when env vars are missing", async () => {
    const consentFlow = vi.fn();
    const { log, logError, errors } = makeLogCapture();

    const exitCode = await runBootstrap({
      env: {},
      consentFlow: consentFlow as unknown as ConsentFlowFn,
      secretsClient,
      log,
      logError,
    });

    expect(exitCode).not.toBe(0);
    expect(consentFlow).not.toHaveBeenCalled();
    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
    expect(errors.some((e) => e.includes("GOOGLE_CLIENT_ID"))).toBe(true);
  });

  it("writes the correct PutSecretValueCommand input on a successful consent flow", async () => {
    smMock.on(PutSecretValueCommand).resolves({});
    const { log, logError } = makeLogCapture();

    const exitCode = await runBootstrap({
      env: {
        GOOGLE_CLIENT_ID: "client-id-123",
        GOOGLE_CLIENT_SECRET: "client-secret-456",
      },
      consentFlow: makeConsentFlow({ refreshToken: FAKE_REFRESH_TOKEN }),
      secretsClient,
      log,
      logError,
    });

    expect(exitCode).toBe(0);
    const calls = smMock.commandCalls(PutSecretValueCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.SecretId).toBe("email-concierge/gmail-oauth");
    const parsed = JSON.parse(input?.SecretString as string) as unknown;
    expect(parsed).toEqual({
      clientId: "client-id-123",
      clientSecret: "client-secret-456",
      refreshToken: FAKE_REFRESH_TOKEN,
    });
  });

  it("respects GMAIL_OAUTH_SECRET_ARN as the SecretId", async () => {
    smMock.on(PutSecretValueCommand).resolves({});

    const exitCode = await runBootstrap({
      env: {
        GOOGLE_CLIENT_ID: "client-id-123",
        GOOGLE_CLIENT_SECRET: "client-secret-456",
        GMAIL_OAUTH_SECRET_ARN:
          "arn:aws:secretsmanager:us-east-1:123:secret:foo",
      },
      consentFlow: makeConsentFlow(),
      secretsClient,
    });

    expect(exitCode).toBe(0);
    const calls = smMock.commandCalls(PutSecretValueCommand);
    expect(calls[0]?.args[0].input.SecretId).toBe(
      "arn:aws:secretsmanager:us-east-1:123:secret:foo",
    );
  });

  it("prints the consent URL for the user to open", async () => {
    smMock.on(PutSecretValueCommand).resolves({});
    const { log, logs } = makeLogCapture();

    await runBootstrap({
      env: {
        GOOGLE_CLIENT_ID: "client-id-123",
        GOOGLE_CLIENT_SECRET: "client-secret-456",
      },
      consentFlow: makeConsentFlow({
        consentUrl: "https://accounts.google.com/o/oauth2/very-specific-url",
      }),
      secretsClient,
      log,
    });

    expect(
      logs.some((l) =>
        l.includes("https://accounts.google.com/o/oauth2/very-specific-url"),
      ),
    ).toBe(true);
  });

  it("catches a consent-flow failure (denial) and reports it clearly instead of throwing", async () => {
    const { log, logError, errors } = makeLogCapture();

    const exitCode = await runBootstrap({
      env: {
        GOOGLE_CLIENT_ID: "client-id-123",
        GOOGLE_CLIENT_SECRET: "client-secret-456",
      },
      consentFlow: makeConsentFlow({
        reject: new Error("OAuth consent denied or failed: access_denied"),
      }),
      secretsClient,
      log,
      logError,
    });

    expect(exitCode).not.toBe(0);
    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
    expect(errors.some((e) => e.includes("access_denied"))).toBe(true);
  });

  it("catches a Secrets Manager write failure and reports it clearly instead of an unhandled rejection", async () => {
    smMock.on(PutSecretValueCommand).rejects(
      Object.assign(
        new Error("User is not authorized to perform this action"),
        {
          name: "AccessDeniedException",
        },
      ),
    );
    const { log, logError, errors } = makeLogCapture();

    const exitCode = await runBootstrap({
      env: {
        GOOGLE_CLIENT_ID: "client-id-123",
        GOOGLE_CLIENT_SECRET: "client-secret-456",
      },
      consentFlow: makeConsentFlow(),
      secretsClient,
      log,
      logError,
    });

    expect(exitCode).not.toBe(0);
    expect(errors.some((e) => e.includes("not authorized"))).toBe(true);
  });

  it("never logs the refresh token or client secret value", async () => {
    smMock.on(PutSecretValueCommand).resolves({});
    const { log, logError, logs, errors } = makeLogCapture();

    await runBootstrap({
      env: {
        GOOGLE_CLIENT_ID: "client-id-123",
        GOOGLE_CLIENT_SECRET: "super-secret-client-secret-value",
      },
      consentFlow: makeConsentFlow({ refreshToken: FAKE_REFRESH_TOKEN }),
      secretsClient,
      log,
      logError,
    });

    const allOutput = [...logs, ...errors].join("\n");
    expect(allOutput).not.toContain(FAKE_REFRESH_TOKEN);
    expect(allOutput).not.toContain("super-secret-client-secret-value");
  });
});
