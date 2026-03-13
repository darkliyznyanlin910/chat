import {
  exchangeCodeForToken,
  extendToken,
  fetchWABAInfo,
  loadCredentialsFromEnv,
  subscribeToWebhooks,
} from "@chat-adapter/whatsapp-coexistence";
import { credentialStore, mode } from "@/lib/bot";

/**
 * OAuth callback for Embedded Signup.
 *
 * After the business owner scans the QR code in the Embedded Signup flow,
 * Meta redirects here with an authorization code and WABA ID.
 *
 * This endpoint:
 * 1. Exchanges the code for a short-lived token
 * 2. Extends it to a long-lived token (60 days)
 * 3. Discovers phone number IDs from the WABA
 * 4. Subscribes the WABA to webhooks
 * 5. Stores credentials in the credential store
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const wabaId = url.searchParams.get("waba_id");

  if (!code || !wabaId) {
    return Response.json(
      {
        error: "Missing required parameters",
        details: "Both 'code' and 'waba_id' query parameters are required",
      },
      { status: 400 }
    );
  }

  try {
    const credentials = loadCredentialsFromEnv();

    // Step 1: Exchange authorization code for short-lived token
    const { accessToken: shortLived } = await exchangeCodeForToken(
      code,
      credentials
    );
    console.log("[auth] Exchanged code for short-lived token");

    // Step 2: Extend to long-lived token (60 days)
    const { accessToken, expiresIn } = await extendToken(
      shortLived,
      credentials
    );
    console.log(
      `[auth] Extended to long-lived token (expires in ${expiresIn}s)`
    );

    // Step 3: Discover phone numbers
    const waba = await fetchWABAInfo(wabaId, accessToken);
    const phoneNumbers = waba.phoneNumbers.map((p) => ({
      id: p.id,
      displayNumber: p.display_phone_number,
      verifiedName: p.verified_name,
    }));
    console.log(`[auth] Found ${phoneNumbers.length} phone number(s)`);

    // Step 4: Subscribe to webhooks
    await subscribeToWebhooks(wabaId, accessToken);
    console.log("[auth] Subscribed to webhooks");

    // Step 5: Store credentials for each phone number
    // Note: verifyToken is shared across all numbers (from WHATSAPP_VERIFY_TOKEN env var),
    // so it is NOT stored per-number in the credential store.
    const tokenExpiresAt = expiresIn
      ? Math.floor(Date.now() / 1000) + expiresIn
      : 0;

    for (const phone of phoneNumbers) {
      await credentialStore.set(phone.id, {
        accessToken,
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.displayNumber,
        wabaId,
        tokenExpiresAt,
      });
      console.log(`[auth] Stored credentials for phone ${phone.id}`);
    }

    const response: Record<string, unknown> = {
      success: true,
      mode,
      phoneNumbers,
      expiresInDays: Math.round((expiresIn ?? 0) / 86400),
    };

    if (mode === "single") {
      response.message =
        "Credentials obtained. Set these environment variables and restart:";
      response.envVars = {
        WHATSAPP_ACCESS_TOKEN: `${accessToken.slice(0, 10)}...`,
        WHATSAPP_PHONE_NUMBER_ID: phoneNumbers[0]?.id,
      };
    } else {
      response.message = `Credentials stored for ${phoneNumbers.length} phone number(s). The adapter will pick them up automatically.`;
      response.registeredNumbers = await credentialStore.list();
    }

    return Response.json(response);
  } catch (err) {
    console.error("[auth] Signup callback error:", err);
    return Response.json(
      {
        error: "Authentication failed",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
