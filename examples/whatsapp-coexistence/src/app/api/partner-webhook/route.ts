import { adapter } from "@/lib/bot";
import type { WhatsAppCoexistenceAdapter } from "@chat-adapter/whatsapp-coexistence";

export async function POST(request: Request): Promise<Response> {
  if (!adapter) {
    return new Response("Adapter not configured", { status: 503 });
  }

  try {
    const payload = await request.json();

    // History sync events arrive on the partner webhook
    if (payload.event === "history") {
      await (adapter as WhatsAppCoexistenceAdapter).handleHistoryWebhook(
        payload
      );
      console.log(
        "[history] Processed history chunk:",
        payload.data?.history?.[0]?.metadata?.progress ?? "unknown",
        "% complete"
      );
      return new Response("ok", { status: 200 });
    }

    // Log other partner webhook events
    console.log("[partner-webhook] Unhandled event:", payload.event);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[partner-webhook] Error:", err);
    return new Response("Internal error", { status: 500 });
  }
}
