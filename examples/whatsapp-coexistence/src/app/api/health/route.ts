import {
  debugToken,
  loadCredentialsFromEnv,
} from "@chat-adapter/whatsapp-coexistence";
import { credentialStore, mode } from "@/lib/bot";

/**
 * Health check endpoint.
 *
 * Returns the status of:
 * - Mode (single/multi)
 * - Registered phone numbers and their token validity
 */
export async function GET(): Promise<Response> {
  const checks: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    mode,
  };

  const phoneNumbers = await credentialStore.list();
  checks.registeredNumbers = phoneNumbers.length;

  if (phoneNumbers.length === 0) {
    return Response.json(
      { ...checks, healthy: false, error: "No phone numbers registered" },
      { status: 503 }
    );
  }

  // Check token health for each registered number
  let credentials: { appId: string; appSecret: string } | null = null;
  try {
    credentials = loadCredentialsFromEnv();
  } catch {
    // App credentials not configured — skip token debug
  }

  const numberStatuses = [];
  let allHealthy = true;

  for (const phoneNumberId of phoneNumbers) {
    const creds = await credentialStore.get(phoneNumberId);
    if (!creds) {
      numberStatuses.push({ phoneNumberId, status: "missing credentials" });
      allHealthy = false;
      continue;
    }

    const entry: Record<string, unknown> = {
      phoneNumberId,
      displayPhoneNumber: creds.displayPhoneNumber ?? "unknown",
    };

    if (credentials && creds.accessToken) {
      try {
        const debug = await debugToken(creds.accessToken, credentials);
        entry.tokenValid = debug.isValid;
        entry.scopes = debug.scopes;

        if (debug.expiresAt > 0) {
          const daysLeft = Math.round(
            (debug.expiresAt * 1000 - Date.now()) / 86400000
          );
          entry.tokenExpiresAt = new Date(
            debug.expiresAt * 1000
          ).toISOString();
          entry.daysRemaining = daysLeft;

          if (daysLeft < 7) {
            entry.warning = "Token expires soon — refresh recommended";
          }
        } else {
          entry.tokenExpiry = "never (system user token)";
        }

        if (!debug.isValid) {
          allHealthy = false;
          entry.error = debug.error?.message;
        }
      } catch (err) {
        entry.tokenValid = false;
        entry.error = err instanceof Error ? err.message : "Check failed";
        allHealthy = false;
      }
    } else {
      entry.tokenValid = "unknown (app credentials not configured for debug)";
    }

    numberStatuses.push(entry);
  }

  checks.numbers = numberStatuses;
  checks.healthy = allHealthy;

  return Response.json(checks, { status: allHealthy ? 200 : 503 });
}
