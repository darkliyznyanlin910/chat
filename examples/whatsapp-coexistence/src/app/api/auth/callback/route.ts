import {
  exchangeCodeForToken,
  extendToken,
  fetchWABAInfo,
  loadCredentialsFromEnv,
  subscribeToWebhooks,
} from "@chat-adapter/whatsapp-coexistence";

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
 * 5. Returns the credentials to store securely
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
    console.log(`[auth] Extended to long-lived token (expires in ${expiresIn}s)`);

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

    // Return credentials (in production, store these securely!)
    return Response.json({
      success: true,
      message:
        "Coexistence setup complete! Store these credentials securely.",
      credentials: {
        accessToken: `${accessToken.slice(0, 10)}...${accessToken.slice(-5)}`,
        expiresInDays: Math.round((expiresIn ?? 0) / 86400),
        phoneNumbers,
        wabaId,
      },
      nextSteps: [
        "Set WHATSAPP_ACCESS_TOKEN in your environment",
        `Set WHATSAPP_PHONE_NUMBER_ID to ${phoneNumbers[0]?.id ?? "your-phone-number-id"}`,
        "Restart the application",
      ],
    });
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
