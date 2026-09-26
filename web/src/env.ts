/**
 * Reads and validates the Vite-injected env vars this app needs at runtime.
 * Fails loudly at startup rather than surfacing an opaque Cognito/fetch
 * error later if a build was deployed without the right env configured.
 */
function requireEnv(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  cognitoUserPoolId: requireEnv("VITE_COGNITO_USER_POOL_ID"),
  cognitoClientId: requireEnv("VITE_COGNITO_CLIENT_ID"),
  apiUrl: requireEnv("VITE_API_URL"),
};

/** Joins a path onto the configured API base URL, tolerating a trailing slash either way. */
export function apiUrlFor(path: string): string {
  const base = env.apiUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}
