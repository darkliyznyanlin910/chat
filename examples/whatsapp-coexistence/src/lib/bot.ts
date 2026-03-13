import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createWhatsAppCoexistenceAdapter,
  StateCredentialStore,
  StaticCredentialStore,
  type CredentialStore,
  type PhoneNumberCredentials,
  type WhatsAppCoexistenceAdapter,
} from "@chat-adapter/whatsapp-coexistence";
import { Chat, ConsoleLogger } from "chat";
import type { StateAdapter } from "chat";

const logger = new ConsoleLogger("debug");

// ── State adapter (shared across modes) ───────────────────────────────
// In production, swap for RedisState / PostgresState / IoRedisState
export const state = createMemoryState();

// ── Mode detection ────────────────────────────────────────────────────
// WHATSAPP_MODE=multi  → credentials stored in state adapter, supports N numbers
// WHATSAPP_MODE=single → credentials from env vars, one number (default)
const mode = (process.env.WHATSAPP_MODE ?? "single") as "single" | "multi";

// ── Credential store ──────────────────────────────────────────────────
export const credentialStore: CredentialStore = createCredentialStore(
  mode,
  state
);

function createCredentialStore(
  mode: "single" | "multi",
  stateAdapter: StateAdapter
): CredentialStore {
  if (mode === "multi") {
    return new StateCredentialStore(stateAdapter);
  }

  // Single-number mode: read from env vars
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!accessToken || !phoneNumberId || !verifyToken) {
    console.warn(
      "[bot] Single-number mode requires WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN"
    );
    // Return an empty static store — adapter won't be created
    return new StaticCredentialStore({
      accessToken: "",
      phoneNumberId: "",
      verifyToken: "",
    });
  }

  return new StaticCredentialStore({
    accessToken,
    phoneNumberId,
    verifyToken,
  });
}

// ── Adapter cache (multi-number: one adapter per phone number) ────────
const adapterCache = new Map<string, WhatsAppCoexistenceAdapter>();

/**
 * Get or create an adapter for a phone number.
 * In single-number mode, always returns the same adapter.
 * In multi-number mode, creates adapters on demand from the credential store.
 */
export async function getAdapter(
  phoneNumberId: string
): Promise<WhatsAppCoexistenceAdapter | null> {
  const cached = adapterCache.get(phoneNumberId);
  if (cached) return cached;

  const creds = await credentialStore.get(phoneNumberId);
  if (!creds || !creds.accessToken) return null;

  return createAdapterFromCredentials(creds);
}

function createAdapterFromCredentials(
  creds: PhoneNumberCredentials
): WhatsAppCoexistenceAdapter {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    throw new Error("WHATSAPP_APP_SECRET is required in both modes");
  }

  const adapter = createWhatsAppCoexistenceAdapter({
    accessToken: creds.accessToken,
    appSecret,
    phoneNumberId: creds.phoneNumberId,
    verifyToken: creds.verifyToken,
    logger: logger.child(`whatsapp:${creds.phoneNumberId}`),
    humanTakeoverTtlMs: 30 * 60 * 1000,

    onMessageEcho: (event) => {
      console.log(
        `[echo] Human replied in ${event.threadId}: ${event.echo.text?.body ?? `[${event.echo.type}]`}`
      );
    },

    onContactSync: (event) => {
      console.log(
        `[sync] ${event.contacts.length} contacts synced for phone ${event.phoneNumberId}`
      );
    },
  });

  adapterCache.set(creds.phoneNumberId, adapter);
  return adapter;
}

// ── Primary adapter + Chat instance (for webhook routing) ─────────────

let primaryAdapter: WhatsAppCoexistenceAdapter | undefined;
let bot: Chat | null = null;

async function initPrimary(): Promise<void> {
  const phoneNumbers = await credentialStore.list();

  if (phoneNumbers.length === 0) {
    console.warn("[bot] No phone numbers configured. Set up credentials first.");
    return;
  }

  // Use the first registered number as the primary adapter
  const primaryCreds = await credentialStore.get(phoneNumbers[0]);
  if (!primaryCreds || !primaryCreds.accessToken) {
    console.warn("[bot] Primary phone number has no valid credentials.");
    return;
  }

  try {
    primaryAdapter = createAdapterFromCredentials(primaryCreds);
  } catch (err) {
    console.warn(
      "[bot] Failed to create adapter:",
      err instanceof Error ? err.message : err
    );
    return;
  }

  bot = new Chat({
    userName: process.env.BOT_USERNAME ?? "whatsapp-bot",
    adapters: { whatsapp: primaryAdapter },
    state,
    logger: "debug",
  });

  registerHandlers(bot, primaryAdapter);
}

function registerHandlers(
  chat: Chat,
  adapter: WhatsAppCoexistenceAdapter
): void {
  chat.onNewMessage("whatsapp", async (thread, message) => {
    console.log(`[msg] ${message.author.userName}: ${message.text}`);

    const text = message.text.toLowerCase().trim();

    if (text === "hi" || text === "hello") {
      await thread.post({
        markdown: [
          "Hello! I'm a bot running in coexistence mode.",
          "A human can also reply from the WhatsApp Business App.",
          "",
          "Say **help** to see what I can do.",
        ].join("\n"),
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
          `Running in **${mode}-number** mode.`,
          "",
          "A human operator can take over anytime from the WhatsApp Business App.",
          "When they do, I'll pause for 30 minutes.",
        ].join("\n"),
      });
      return;
    }

    if (text === "status") {
      const router = adapter.getRouter();
      const isHumanActive = router.isHumanActive(thread.id);
      const lastReply = router.getLastHumanReplyAt(thread.id);

      await thread.post({
        markdown: isHumanActive
          ? `A human operator is currently active (last reply: ${lastReply?.toLocaleTimeString()}).`
          : "No human operator is active. I'm handling this thread.",
      });
      return;
    }

    if (text === "hours") {
      const hour = new Date().getHours();
      const isBusinessHours = hour >= 9 && hour < 17;

      await thread.post({
        markdown: isBusinessHours
          ? "We're within business hours (9 AM–5 PM). A human may respond from the Business App."
          : "We're outside business hours. I'll handle your messages until a human is available.",
      });
      return;
    }

    await thread.post({
      markdown: `You said: "${message.text}"\n\nSay **help** to see available commands.`,
    });
  });
}

// Initialize on module load
initPrimary().catch((err) => {
  console.error("[bot] Initialization failed:", err);
});

export { bot, primaryAdapter, mode };
