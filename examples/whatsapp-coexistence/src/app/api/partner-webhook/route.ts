import { getAdapter, credentialStore } from "@/lib/bot";
import type { WhatsAppCoexistenceAdapter } from "@chat-adapter/whatsapp-coexistence";

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = await request.json();

    if (payload.event !== "history") {
      console.log("[partner-webhook] Unhandled event:", payload.event);
      return new Response("ok", { status: 200 });
    }

    // History sync events include phone_number_id in metadata
    const phoneNumberId = payload.data?.metadata?.phone_number_id;
    if (!phoneNumberId) {
      // Fall back to the first registered number
      const numbers = await credentialStore.list();
      if (numbers.length === 0) {
        return new Response("No phone numbers registered", { status: 503 });
      }
      const adapter = await getAdapter(numbers[0]);
      if (!adapter) {
        return new Response("Adapter not configured", { status: 503 });
      }
      await (adapter as WhatsAppCoexistenceAdapter).handleHistoryWebhook(payload);
      return new Response("ok", { status: 200 });
    }

    const adapter = await getAdapter(phoneNumberId);
    if (!adapter) {
      return new Response("Phone number not registered", { status: 404 });
    }

    await (adapter as WhatsAppCoexistenceAdapter).handleHistoryWebhook(payload);
    console.log(
      "[history] Processed chunk:",
      payload.data?.history?.[0]?.metadata?.progress ?? "unknown",
      "% complete"
    );

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[partner-webhook] Error:", err);
    return new Response("Internal error", { status: 500 });
  }
}
