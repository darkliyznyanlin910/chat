/**
 * WhatsApp Coexistence adapter for chat SDK.
 *
 * Wraps the standard WhatsApp Cloud API adapter to add support for
 * coexistence mode — simultaneous use of the WhatsApp Business App
 * and the Cloud API on the same phone number.
 *
 * Key additions over the standard adapter:
 * - Handles `smb_message_echoes` webhooks (messages sent from the Business App)
 * - Handles `history` webhooks (historical message import during onboarding)
 * - Handles `smb_app_state_sync` webhooks (contact sync)
 * - Application-level conversation routing: when the human replies from
 *   the Business App, the bot pauses for a configurable window
 *
 * @example
 * ```typescript
 * import { Chat } from "chat";
 * import { createWhatsAppCoexistenceAdapter } from "@chat-adapter/whatsapp-coexistence";
 * import { MemoryState } from "@chat-adapter/state-memory";
 *
 * const chat = new Chat({
 *   userName: "my-bot",
 *   adapters: {
 *     whatsapp: createWhatsAppCoexistenceAdapter({
 *       humanTakeoverTtlMs: 30 * 60 * 1000, // 30 minutes
 *       onMessageEcho: (event) => {
 *         console.log("Human replied from app:", event.echo.text?.body);
 *       },
 *     }),
 *   },
 *   state: new MemoryState(),
 * });
 * ```
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError } from "@chat-adapter/shared";
import { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger } from "chat";
import type {
  WhatsAppRawMessage,
  WhatsAppThreadId,
} from "@chat-adapter/whatsapp";
import { ConversationRouter } from "./routing";
import type {
  CoexistenceAdapterConfig,
  CoexistenceWebhookPayload,
  ContactSyncEvent,
  HistorySyncEvent,
  HistoryWebhookPayload,
  MessageEchoEvent,
  RoutingContext,
  SyncedContact,
  WhatsAppEchoWebhookValue,
  WhatsAppMessageEcho,
  WhatsAppStateSyncValue,
} from "./types";

/** Default human takeover window: 30 minutes */
const DEFAULT_TAKEOVER_TTL_MS = 30 * 60 * 1000;

// Re-export types
export type {
  CoexistenceAdapterConfig,
  ContactSyncEvent,
  HistorySyncEvent,
  MessageEchoEvent,
  RoutingContext,
  WhatsAppMessageEcho,
} from "./types";
export { ConversationRouter } from "./routing";
export {
  debugToken,
  exchangeCodeForToken,
  extendToken,
  fetchWABAInfo,
  generateVerifyToken,
  loadCredentialsFromEnv,
  subscribeToWebhooks,
  validateEnv,
} from "./auth";
export type {
  AppCredentials,
  PhoneNumberInfo,
  TokenDebugResult,
  TokenExchangeResult,
  WABAInfo,
} from "./auth";

/**
 * WhatsApp Coexistence adapter for chat SDK.
 *
 * Wraps the standard `WhatsAppAdapter` and intercepts webhooks to handle
 * coexistence-specific events. All standard Cloud API functionality
 * (sending messages, reactions, media, etc.) is delegated to the base adapter.
 *
 * Conversation routing: when the human replies from the Business App
 * (detected via `smb_message_echoes`), the adapter suppresses bot processing
 * of inbound customer messages for a configurable window. This prevents
 * the bot and human from talking over each other.
 */
export class WhatsAppCoexistenceAdapter
  implements Adapter<WhatsAppThreadId, WhatsAppRawMessage>
{
  readonly name = "whatsapp";
  readonly persistMessageHistory = true;

  private readonly inner: WhatsAppAdapter;
  private readonly router: ConversationRouter;
  private readonly logger: Logger;
  private readonly appSecret: string;
  private readonly phoneNumberId: string;
  private readonly verifyToken: string;
  private readonly onMessageEcho?: CoexistenceAdapterConfig["onMessageEcho"];
  private readonly onHistorySync?: CoexistenceAdapterConfig["onHistorySync"];
  private readonly onContactSync?: CoexistenceAdapterConfig["onContactSync"];
  private readonly shouldBotRespond?: CoexistenceAdapterConfig["shouldBotRespond"];
  private chat: ChatInstance | null = null;

  get userName(): string {
    return this.inner.userName;
  }

  get botUserId(): string | undefined {
    return this.inner.botUserId;
  }

  constructor(config: CoexistenceAdapterConfig) {
    this.inner = new WhatsAppAdapter(config);
    this.logger = config.logger;
    this.appSecret = config.appSecret;
    this.phoneNumberId = config.phoneNumberId;
    this.verifyToken = config.verifyToken;
    this.onMessageEcho = config.onMessageEcho;
    this.onHistorySync = config.onHistorySync;
    this.onContactSync = config.onContactSync;
    this.shouldBotRespond = config.shouldBotRespond;
    this.router = new ConversationRouter(
      config.humanTakeoverTtlMs ?? DEFAULT_TAKEOVER_TTL_MS
    );
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    await this.inner.initialize(chat);
    this.logger.info("WhatsApp coexistence adapter initialized", {
      phoneNumberId: this.phoneNumberId,
    });
  }

  /**
   * Handle incoming webhook from WhatsApp.
   *
   * Intercepts the webhook to handle coexistence-specific events
   * (`smb_message_echoes`, `smb_app_state_sync`) before delegating
   * standard `messages` events to the base adapter — with routing
   * logic to suppress bot responses when the human is active.
   */
  async handleWebhook(
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> {
    // GET verification challenge — delegate directly
    if (request.method === "GET") {
      return this.inner.handleWebhook(request, options);
    }

    const body = await request.text();

    // Verify signature
    const signature = request.headers.get("x-hub-signature-256");
    if (!this.verifySignature(body, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: CoexistenceWebhookPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    let hasStandardMessages = false;

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field === "smb_message_echoes") {
          this.handleEchoChange(change.value as WhatsAppEchoWebhookValue);
        } else if (change.field === "smb_app_state_sync") {
          this.handleStateSyncChange(change.value as WhatsAppStateSyncValue);
        } else if (change.field === "messages") {
          hasStandardMessages = true;
        }
      }
    }

    // If there are standard messages, check routing before delegating
    if (hasStandardMessages) {
      const shouldProcess = await this.shouldProcessMessages(payload);
      if (shouldProcess) {
        // Reconstruct the request for the base adapter (body already consumed)
        const forwardRequest = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        });
        return this.inner.handleWebhook(forwardRequest, options);
      }
      // Human is active — acknowledge but don't process
      this.logger.debug("Suppressing bot processing — human is active on Business App");
    }

    return new Response("ok", { status: 200 });
  }

  /**
   * Handle a `history` webhook for historical message import.
   *
   * Call this from your webhook endpoint when you receive a history
   * event (these come on the partner webhook, not the phone number webhook).
   *
   * @example
   * ```typescript
   * // In your webhook handler:
   * if (payload.event === "history") {
   *   await adapter.handleHistoryWebhook(payload);
   * }
   * ```
   */
  async handleHistoryWebhook(payload: HistoryWebhookPayload): Promise<void> {
    if (!this.onHistorySync) {
      this.logger.debug("History webhook received but no onHistorySync handler configured");
      return;
    }

    for (const chunk of payload.data.history) {
      const event: HistorySyncEvent = {
        phoneNumberId: payload.data.metadata.phone_number_id,
        threads: chunk.threads,
        chunkMeta: chunk.metadata,
      };

      try {
        await this.onHistorySync(event);
      } catch (error) {
        this.logger.error("Failed to process history sync chunk", {
          chunkOrder: chunk.metadata.chunk_order,
          error,
        });
      }
    }
  }

  /**
   * Access the conversation router for manual control.
   *
   * Use this to manually release a thread back to the bot
   * or check routing state.
   *
   * @example
   * ```typescript
   * // Release a thread so the bot can respond again
   * adapter.getRouter().releaseThread(threadId);
   *
   * // Check if human is currently active
   * const active = adapter.getRouter().isHumanActive(threadId);
   * ```
   */
  getRouter(): ConversationRouter {
    return this.router;
  }

  /**
   * Clean up resources. Call on shutdown.
   */
  dispose(): void {
    this.router.dispose();
  }

  // =========================================================================
  // Delegated methods — pass through to the base WhatsApp adapter
  // =========================================================================

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    return this.inner.postMessage(threadId, message);
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    return this.inner.editMessage(threadId, messageId, message);
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    return this.inner.deleteMessage(threadId, messageId);
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    return this.inner.stream(threadId, textStream, options);
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    return this.inner.addReaction(threadId, messageId, emoji);
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    return this.inner.removeReaction(threadId, messageId, emoji);
  }

  async startTyping(threadId: string, status?: string): Promise<void> {
    return this.inner.startTyping(threadId, status);
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult<WhatsAppRawMessage>> {
    return this.inner.fetchMessages(threadId, options);
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return this.inner.fetchThread(threadId);
  }

  async openDM(userId: string): Promise<string> {
    return this.inner.openDM(userId);
  }

  encodeThreadId(platformData: WhatsAppThreadId): string {
    return this.inner.encodeThreadId(platformData);
  }

  decodeThreadId(threadId: string): WhatsAppThreadId {
    return this.inner.decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return this.inner.channelIdFromThreadId(threadId);
  }

  isDM(threadId: string): boolean {
    return this.inner.isDM(threadId);
  }

  parseMessage(raw: WhatsAppRawMessage) {
    return this.inner.parseMessage(raw);
  }

  renderFormatted(content: FormattedContent): string {
    return this.inner.renderFormatted(content);
  }

  // =========================================================================
  // Private — coexistence-specific logic
  // =========================================================================

  /**
   * Handle the smb_message_echoes webhook change.
   */
  private handleEchoChange(value: WhatsAppEchoWebhookValue): void {
    const phoneNumberId = value.metadata.phone_number_id;

    for (const echo of value.message_echoes) {
      const threadId = this.encodeThreadId({
        phoneNumberId,
        userWaId: echo.to,
      });

      // Record that the human is active on this thread
      this.router.recordHumanReply(threadId);

      this.logger.debug("Business App message echo received", {
        threadId,
        messageId: echo.id,
        type: echo.type,
      });

      if (this.onMessageEcho) {
        const event: MessageEchoEvent = {
          echo,
          phoneNumberId,
          threadId,
        };

        try {
          const result = this.onMessageEcho(event);
          if (result instanceof Promise) {
            result.catch((error) => {
              this.logger.error("onMessageEcho handler failed", { error });
            });
          }
        } catch (error) {
          this.logger.error("onMessageEcho handler failed", { error });
        }
      }
    }
  }

  /**
   * Handle the smb_app_state_sync webhook change.
   */
  private handleStateSyncChange(value: WhatsAppStateSyncValue): void {
    if (!this.onContactSync) {
      return;
    }

    const event: ContactSyncEvent = {
      phoneNumberId: value.metadata.phone_number_id,
      contacts: value.contacts,
    };

    try {
      const result = this.onContactSync(event);
      if (result instanceof Promise) {
        result.catch((error) => {
          this.logger.error("onContactSync handler failed", { error });
        });
      }
    } catch (error) {
      this.logger.error("onContactSync handler failed", { error });
    }
  }

  /**
   * Determine whether the bot should process incoming customer messages.
   *
   * Checks each message's thread against the routing logic:
   * - If a custom `shouldBotRespond` function is provided, calls it
   * - Otherwise, checks if the human replied recently via the router
   *
   * Returns true if any message should be processed.
   */
  private async shouldProcessMessages(
    payload: CoexistenceWebhookPayload
  ): Promise<boolean> {
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== "messages") {
          continue;
        }

        const value = change.value as {
          metadata: { phone_number_id: string };
          messages?: Array<{ from: string }>;
        };

        if (!value.messages) {
          continue;
        }

        for (const msg of value.messages) {
          const threadId = this.encodeThreadId({
            phoneNumberId: value.metadata.phone_number_id,
            userWaId: msg.from,
          });

          if (this.shouldBotRespond) {
            const context: RoutingContext = {
              threadId,
              customerWaId: msg.from,
              phoneNumberId: value.metadata.phone_number_id,
              lastHumanReplyAt: this.router.getLastHumanReplyAt(threadId),
              msSinceHumanReply: this.router.getMsSinceHumanReply(threadId),
            };

            const result = await this.shouldBotRespond(context);
            if (result) {
              return true;
            }
          } else {
            // Default: process if the human is NOT active
            if (!this.router.isHumanActive(threadId)) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Verify webhook signature using HMAC-SHA256 with the App Secret.
   */
  private verifySignature(body: string, signature: string | null): boolean {
    if (!signature) {
      return false;
    }

    const expectedSignature = `sha256=${createHmac("sha256", this.appSecret).update(body).digest("hex")}`;

    try {
      return timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch {
      return false;
    }
  }
}

/**
 * Factory function to create a WhatsApp Coexistence adapter.
 *
 * @example
 * ```typescript
 * const adapter = createWhatsAppCoexistenceAdapter({
 *   humanTakeoverTtlMs: 30 * 60 * 1000,
 *   onMessageEcho: (event) => {
 *     console.log("Human replied:", event.echo.text?.body);
 *   },
 * });
 * ```
 */
export function createWhatsAppCoexistenceAdapter(config?: {
  accessToken?: string;
  apiVersion?: string;
  appSecret?: string;
  humanTakeoverTtlMs?: number;
  logger?: Logger;
  onContactSync?: CoexistenceAdapterConfig["onContactSync"];
  onHistorySync?: CoexistenceAdapterConfig["onHistorySync"];
  onMessageEcho?: CoexistenceAdapterConfig["onMessageEcho"];
  phoneNumberId?: string;
  shouldBotRespond?: CoexistenceAdapterConfig["shouldBotRespond"];
  userName?: string;
  verifyToken?: string;
}): WhatsAppCoexistenceAdapter {
  const logger = config?.logger ?? new ConsoleLogger("info").child("whatsapp-coexistence");

  const accessToken = config?.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new ValidationError(
      "whatsapp-coexistence",
      "accessToken is required. Set WHATSAPP_ACCESS_TOKEN or provide it in config."
    );
  }

  const appSecret = config?.appSecret ?? process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    throw new ValidationError(
      "whatsapp-coexistence",
      "appSecret is required. Set WHATSAPP_APP_SECRET or provide it in config."
    );
  }

  const phoneNumberId =
    config?.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) {
    throw new ValidationError(
      "whatsapp-coexistence",
      "phoneNumberId is required. Set WHATSAPP_PHONE_NUMBER_ID or provide it in config."
    );
  }

  const verifyToken = config?.verifyToken ?? process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) {
    throw new ValidationError(
      "whatsapp-coexistence",
      "verifyToken is required. Set WHATSAPP_VERIFY_TOKEN or provide it in config."
    );
  }

  const userName =
    config?.userName ?? process.env.WHATSAPP_BOT_USERNAME ?? "whatsapp-bot";

  return new WhatsAppCoexistenceAdapter({
    accessToken,
    apiVersion: config?.apiVersion,
    appSecret,
    phoneNumberId,
    verifyToken,
    userName,
    logger,
    humanTakeoverTtlMs: config?.humanTakeoverTtlMs,
    onMessageEcho: config?.onMessageEcho,
    onHistorySync: config?.onHistorySync,
    onContactSync: config?.onContactSync,
    shouldBotRespond: config?.shouldBotRespond,
  });
}
