import { after } from "next/server";
import { bot, getAdapter, mode, credentialStore } from "@/lib/bot";

/**
 * GET — webhook verification challenge.
 *
 * In single-number mode, delegates to the primary adapter.
 * In multi-number mode, checks all registered verify tokens.
 */
export async function GET(request: Request): Promise<Response> {
  if (mode === "single" && bot) {
    return bot.webhooks.whatsapp(request);
  }

  // Multi-number: verify token could belong to any registered number
  const url = new URL(request.url);
  const hubMode = url.searchParams.get("hub.mode");
  const hubToken = url.searchParams.get("hub.verify_token");
  const hubChallenge = url.searchParams.get("hub.challenge");

  if (hubMode !== "subscribe" || !hubToken || !hubChallenge) {
    return new Response("Missing verification parameters", { status: 400 });
  }

  // Check all registered numbers for a matching verify token
  const phoneNumbers = await credentialStore.list();
  for (const phoneNumberId of phoneNumbers) {
    const creds = await credentialStore.get(phoneNumberId);
    if (creds?.verifyToken === hubToken) {
      return new Response(hubChallenge, { status: 200 });
    }
  }

  return new Response("Invalid verify token", { status: 403 });
}

/**
 * POST — incoming webhook.
 *
 * In single-number mode, delegates to the primary bot instance.
 * In multi-number mode, extracts phone_number_id from the payload
 * metadata and routes to the correct adapter.
 */
export async function POST(request: Request): Promise<Response> {
  if (mode === "single" && bot) {
    return bot.webhooks.whatsapp(request, {
      waitUntil: (task) => after(() => task),
    });
  }

  // Multi-number: parse payload to find target phone number ID,
  // then route to the correct adapter instance
  const body = await request.text();

  let payload: {
    entry?: Array<{
      changes?: Array<{
        value?: { metadata?: { phone_number_id?: string } };
      }>;
    }>;
  };

  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Extract phone_number_id from the first change entry
  const phoneNumberId =
    payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

  if (!phoneNumberId) {
    return new Response("Missing phone_number_id in payload", { status: 400 });
  }

  const adapter = await getAdapter(phoneNumberId);
  if (!adapter) {
    console.warn(`[webhook] No adapter for phone number ${phoneNumberId}`);
    return new Response("Phone number not registered", { status: 404 });
  }

  // Reconstruct request with the already-consumed body
  const forwardRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body,
  });

  return adapter.handleWebhook(forwardRequest, {
    waitUntil: (task) => after(() => task),
  });
}
