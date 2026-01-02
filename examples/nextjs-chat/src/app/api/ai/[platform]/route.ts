import { after } from "next/server";
import { aiBot } from "@/lib/ai-bot";

type Platform = keyof typeof aiBot.webhooks;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform } = await params;

  const webhookHandler = aiBot.webhooks[platform as Platform];
  if (!webhookHandler) {
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }

  return webhookHandler(request, {
    waitUntil: (task) => after(() => task),
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform } = await params;

  const hasAdapter = aiBot.webhooks[platform as Platform] !== undefined;

  if (hasAdapter) {
    return new Response(`AI bot ${platform} webhook is active`, { status: 200 });
  }
  return new Response(`${platform} adapter not configured`, { status: 404 });
}
