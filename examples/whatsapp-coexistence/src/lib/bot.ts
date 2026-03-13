import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createWhatsAppCoexistenceAdapter,
  type WhatsAppCoexistenceAdapter,
} from "@chat-adapter/whatsapp-coexistence";
import { Chat, ConsoleLogger } from "chat";

const logger = new ConsoleLogger("debug");

let adapter: WhatsAppCoexistenceAdapter | undefined;

try {
  adapter = createWhatsAppCoexistenceAdapter({
    logger: logger.child("whatsapp"),
    humanTakeoverTtlMs: 30 * 60 * 1000, // 30 minutes

    onMessageEcho: (event) => {
      console.log(
        `[echo] Human replied in ${event.threadId}: ${event.echo.text?.body ?? `[${event.echo.type}]`}`
      );
    },

    onContactSync: (event) => {
      console.log(
        `[sync] ${event.contacts.length} contacts synced from Business App`
      );
    },
  });
} catch (err) {
  console.warn(
    "[bot] WhatsApp coexistence adapter not configured:",
    err instanceof Error ? err.message : err
  );
}

const state = createMemoryState();

export const bot = adapter
  ? new Chat({
      userName: process.env.BOT_USERNAME ?? "whatsapp-bot",
      adapters: { whatsapp: adapter },
      state,
      logger: "debug",
    })
  : null;

// ── Bot handlers ──────────────────────────────────────────────────────

if (bot) {
  // Handle all incoming WhatsApp messages
  bot.onNewMessage("whatsapp", async (thread, message) => {
    console.log(
      `[msg] ${message.author.userName}: ${message.text}`
    );

    const text = message.text.toLowerCase().trim();

    if (text === "hi" || text === "hello") {
      await thread.post({
        markdown: `Hello! I'm a bot running in coexistence mode. A human can also reply from the WhatsApp Business App.\n\nSay **help** to see what I can do.`,
      });
      return;
    }

    if (text === "help") {
      await thread.post({
        markdown: [
          "Here's what I can do:",
          "",
          "- **hello** — greeting",
          "- **help** — this message",
          "- **status** — check if a human is active on this thread",
          "- **hours** — business hours info",
          "",
          "A human operator can take over anytime from the WhatsApp Business App. When they do, I'll pause for 30 minutes.",
        ].join("\n"),
      });
      return;
    }

    if (text === "status") {
      const router = adapter!.getRouter();
      const isHumanActive = router.isHumanActive(thread.id);
      const lastReply = router.getLastHumanReplyAt(thread.id);

      await thread.post({
        markdown: isHumanActive
          ? `A human operator is currently active on this thread (last reply: ${lastReply?.toLocaleTimeString()}).`
          : "No human operator is active. I'm handling this thread.",
      });
      return;
    }

    if (text === "hours") {
      const hour = new Date().getHours();
      const isBusinessHours = hour >= 9 && hour < 17;

      await thread.post({
        markdown: isBusinessHours
          ? "We're currently within business hours (9 AM - 5 PM). A human operator may respond from the Business App."
          : "We're outside business hours. I'll handle your messages until a human is available.",
      });
      return;
    }

    // Default echo response
    await thread.post({
      markdown: `You said: "${message.text}"\n\nI'm not sure how to help with that. Say **help** to see available commands.`,
    });
  });
}

export { adapter };
