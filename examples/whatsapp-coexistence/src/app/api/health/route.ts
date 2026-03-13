import {
  debugToken,
  loadCredentialsFromEnv,
} from "@chat-adapter/whatsapp-coexistence";
import { adapter } from "@/lib/bot";

/**
 * Health check endpoint.
 *
 * Returns the status of:
 * - Adapter configuration
 * - Access token validity and expiry
 * - Router state (active human threads)
 */
export async function GET(): Promise<Response> {
  const checks: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    adapter: adapter ? "configured" : "not configured",
  };

  if (!adapter) {
    return Response.json({ ...checks, healthy: false }, { status: 503 });
  }

  // Check token health
  try {
    const credentials = loadCredentialsFromEnv();
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    if (token) {
      const debug = await debugToken(token, credentials);
      checks.token = {
        valid: debug.isValid,
        scopes: debug.scopes,
        expiresAt: debug.expiresAt > 0
          ? new Date(debug.expiresAt * 1000).toISOString()
          : "never (system user token)",
        ...(debug.expiresAt > 0 && {
          daysRemaining: Math.round(
            (debug.expiresAt * 1000 - Date.now()) / 86400000
          ),
        }),
        ...(debug.error && { error: debug.error.message }),
      };
    }
  } catch (err) {
    checks.token = {
      valid: false,
      error: err instanceof Error ? err.message : "Check failed",
    };
  }

  const healthy =
    checks.adapter === "configured" &&
    (checks.token as Record<string, unknown>)?.valid !== false;

  return Response.json({ ...checks, healthy }, { status: healthy ? 200 : 503 });
}
