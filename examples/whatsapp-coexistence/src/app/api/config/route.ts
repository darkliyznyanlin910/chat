/**
 * Exposes non-secret app configuration to the client.
 *
 * Only returns the Facebook App ID (public, already embedded in the
 * Facebook JS SDK init call) and the current mode.
 */
export function GET(): Response {
  return Response.json({
    appId: process.env.FACEBOOK_APP_ID ?? null,
    mode: process.env.WHATSAPP_MODE ?? "single",
  });
}
