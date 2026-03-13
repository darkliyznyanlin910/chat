import { after } from "next/server";
import { bot } from "@/lib/bot";

export async function GET(request: Request): Promise<Response> {
  if (!bot) {
    return new Response("WhatsApp adapter not configured", { status: 503 });
  }
  return bot.webhooks.whatsapp(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!bot) {
    return new Response("WhatsApp adapter not configured", { status: 503 });
  }
  return bot.webhooks.whatsapp(request, {
    waitUntil: (task) => after(() => task),
  });
}
