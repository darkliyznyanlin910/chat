/**
 * Type definitions for the WhatsApp coexistence adapter.
 *
 * Coexistence mode allows simultaneous use of the WhatsApp Business App
 * and the Cloud API on the same phone number. These types cover the
 * three new webhook event types introduced by coexistence:
 *
 * - `smb_message_echoes` — messages sent from the Business App
 * - `smb_app_state_sync` — contact sync from Business App
 * - `history` — historical message import during onboarding
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
 */

import type { WhatsAppAdapterConfig } from "@chat-adapter/whatsapp";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Coexistence adapter configuration.
 *
 * Extends the standard WhatsApp adapter config with routing options
 * that control how conversations are split between the Business App
 * (human operator) and the Cloud API (bot).
 */
export interface CoexistenceAdapterConfig extends WhatsAppAdapterConfig {
  /**
   * Duration in milliseconds to pause bot responses after the human
   * replies from the Business App. When an `smb_message_echoes` event
   * arrives, the adapter suppresses automated messages for this window.
   *
   * @default 1800000 (30 minutes)
   */
  humanTakeoverTtlMs?: number;

  /**
   * Called when a message echo arrives from the Business App.
   * Use this to integrate with your CRM or agent routing system.
   */
  onMessageEcho?: (event: MessageEchoEvent) => void | Promise<void>;

  /**
   * Called when historical messages arrive during onboarding.
   * Use this to import conversation history into your state adapter.
   */
  onHistorySync?: (event: HistorySyncEvent) => void | Promise<void>;

  /**
   * Called when the contact list syncs from the Business App.
   */
  onContactSync?: (event: ContactSyncEvent) => void | Promise<void>;

  /**
   * Custom routing function. When provided, this function is called
   * for each inbound customer message to decide whether the bot
   * should handle it or yield to the human on the Business App.
   *
   * Return `true` to allow the bot to process the message,
   * or `false` to suppress it (the human will handle it on the app).
   *
   * When not provided, the default behavior uses `humanTakeoverTtlMs`:
   * if the human replied recently, the bot stays silent.
   */
  shouldBotRespond?: (context: RoutingContext) => boolean | Promise<boolean>;
}

// =============================================================================
// Webhook Payloads — smb_message_echoes
// =============================================================================

/**
 * A message echo from the WhatsApp Business App.
 *
 * When the human operator sends a message from the Business App,
 * the Cloud API receives this echo so the bot/CRM knows about it.
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/
 */
export interface WhatsAppMessageEcho {
  /** Sender (the business phone number) */
  from: string;
  /** Recipient (the customer's WhatsApp ID) */
  to: string;
  /** Unique message ID */
  id: string;
  /** Unix timestamp string */
  timestamp: string;
  /** Message type */
  type:
    | "text"
    | "image"
    | "document"
    | "audio"
    | "video"
    | "voice"
    | "sticker"
    | "location"
    | "contacts"
    | "interactive"
    | "button"
    | "reaction"
    | "order"
    | "system";
  /** Text content (when type is "text") */
  text?: { body: string };
  /** Image content */
  image?: { id: string; mime_type: string; caption?: string };
  /** Document content */
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  /** Audio content */
  audio?: { id: string; mime_type: string };
  /** Video content */
  video?: { id: string; mime_type: string; caption?: string };
  /** Location content */
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

/**
 * Webhook value for the smb_message_echoes field.
 */
export interface WhatsAppEchoWebhookValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  message_echoes: WhatsAppMessageEcho[];
}

/**
 * A change entry with smb_message_echoes field.
 */
export interface WhatsAppEchoWebhookChange {
  field: "smb_message_echoes";
  value: WhatsAppEchoWebhookValue;
}

// =============================================================================
// Webhook Payloads — history
// =============================================================================

/**
 * A historical message thread imported during coexistence onboarding.
 */
export interface HistoryThread {
  /** Customer phone number */
  id: string;
  /** Historical messages in the thread */
  messages: WhatsAppMessageEcho[];
}

/**
 * History chunk metadata for tracking sync progress.
 */
export interface HistoryChunkMeta {
  /** Sync phase */
  phase: string;
  /** Order of this chunk */
  chunk_order: string;
  /** Progress percentage (0-100) */
  progress: string;
}

/**
 * History sync event data delivered via webhook.
 */
export interface HistoryWebhookData {
  id: string;
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  history: Array<{
    metadata: HistoryChunkMeta;
    threads: HistoryThread[];
  }>;
}

/**
 * Top-level history webhook payload.
 */
export interface HistoryWebhookPayload {
  id: string;
  event: "history";
  data: HistoryWebhookData;
}

// =============================================================================
// Webhook Payloads — smb_app_state_sync
// =============================================================================

/**
 * Contact synced from the WhatsApp Business App.
 */
export interface SyncedContact {
  wa_id: string;
  profile: { name: string };
}

/**
 * Webhook value for smb_app_state_sync field.
 */
export interface WhatsAppStateSyncValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts: SyncedContact[];
}

/**
 * A change entry with smb_app_state_sync field.
 */
export interface WhatsAppStateSyncChange {
  field: "smb_app_state_sync";
  value: WhatsAppStateSyncValue;
}

// =============================================================================
// Extended webhook payload supporting coexistence fields
// =============================================================================

/**
 * Extended webhook change that supports standard messages,
 * smb_message_echoes, and smb_app_state_sync fields.
 */
export interface CoexistenceWebhookChange {
  field: "messages" | "smb_message_echoes" | "smb_app_state_sync";
  value: unknown;
}

/**
 * Extended webhook payload supporting coexistence fields.
 */
export interface CoexistenceWebhookPayload {
  object: "whatsapp_business_account";
  entry: Array<{
    id: string;
    changes: CoexistenceWebhookChange[];
  }>;
}

// =============================================================================
// Event types for callbacks
// =============================================================================

/**
 * Event emitted when a message echo arrives from the Business App.
 */
export interface MessageEchoEvent {
  /** The echoed message */
  echo: WhatsAppMessageEcho;
  /** Phone number ID of the business */
  phoneNumberId: string;
  /** The thread ID (whatsapp:{phoneNumberId}:{customerWaId}) */
  threadId: string;
}

/**
 * Event emitted when historical messages arrive during onboarding.
 */
export interface HistorySyncEvent {
  /** Phone number ID of the business */
  phoneNumberId: string;
  /** Historical threads with messages */
  threads: HistoryThread[];
  /** Chunk metadata for tracking sync progress */
  chunkMeta: HistoryChunkMeta;
}

/**
 * Event emitted when contacts sync from the Business App.
 */
export interface ContactSyncEvent {
  /** Phone number ID of the business */
  phoneNumberId: string;
  /** Synced contacts */
  contacts: SyncedContact[];
}

// =============================================================================
// Routing context
// =============================================================================

/**
 * Context passed to the custom routing function.
 */
export interface RoutingContext {
  /** Thread ID for this conversation */
  threadId: string;
  /** Customer's WhatsApp ID */
  customerWaId: string;
  /** Phone number ID of the business */
  phoneNumberId: string;
  /** Timestamp of the last echo from the Business App for this thread, or null */
  lastHumanReplyAt: Date | null;
  /** How many milliseconds since the last human reply, or Infinity if none */
  msSinceHumanReply: number;
}
