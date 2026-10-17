import type { ProviderError } from "@getpaseo/plugin/server/provider";

export const LOGIN_DIAGNOSTIC =
  'Sign in to Cursor: run "npm run login" in the cursor-sdk-provider plugin directory, or set CURSOR_API_KEY for the daemon.';

// SDK errors carry a stable `code`; match on it and the class name rather than
// `instanceof`, so this works before the SDK module has loaded.
export function providerError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  if (isAuthenticationError(error)) {
    return { message, code: code ?? "unauthenticated", diagnostic: LOGIN_DIAGNOSTIC };
  }
  return code ? { message, code } : { message };
}

function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AuthenticationError" || errorCode(error) === "unauthenticated";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
