# @chat-adapter/whatsapp-coexistence

WhatsApp Coexistence adapter for the [Vercel Chat SDK](https://github.com/vercel/chat). Enables simultaneous use of the **WhatsApp Business App** (human operator) and the **Cloud API** (bot/automation) on the same phone number.

## How Coexistence Works

WhatsApp coexistence (launched February 2025) allows a single business phone number to be connected to both the WhatsApp Business App and the Cloud API at the same time. Messages from customers arrive on both sides, and either the human or the bot can respond.

```mermaid
graph LR
    Customer([Customer]) -->|sends message| WA[WhatsApp Platform]
    WA -->|webhook: messages| CloudAPI[Cloud API / Bot]
    WA -->|appears in app| BusinessApp[Business App / Human]
    CloudAPI -->|sends reply| WA
    BusinessApp -->|sends reply| WA
    BusinessApp -->|webhook: smb_message_echoes| CloudAPI
    WA -->|delivers| Customer
```

The key challenge is **preventing the bot and human from talking over each other**. This adapter solves that with application-level conversation routing.

## Architecture

The adapter wraps the standard `WhatsAppAdapter` (Cloud API only) and intercepts webhooks to handle three new coexistence-specific event types from Meta.

```mermaid
graph TB
    subgraph "Incoming Webhooks"
        WH[Webhook Request]
    end

    subgraph "WhatsAppCoexistenceAdapter"
        WH --> SIG{Verify Signature}
        SIG -->|Invalid| R401[401 Unauthorized]
        SIG -->|Valid| PARSE[Parse Payload]
        PARSE --> ROUTE{Route by field}

        ROUTE -->|smb_message_echoes| ECHO[Handle Echo]
        ECHO --> RECORD[Record Human Activity]
        ECHO --> CB_ECHO[onMessageEcho callback]

        ROUTE -->|smb_app_state_sync| SYNC[Handle Contact Sync]
        SYNC --> CB_SYNC[onContactSync callback]

        ROUTE -->|messages| CHECK{Should Bot Respond?}
        CHECK -->|Human active| SUPPRESS[Suppress - return 200]
        CHECK -->|Bot should respond| DELEGATE[Delegate to WhatsAppAdapter]
    end

    subgraph "WhatsAppAdapter (base)"
        DELEGATE --> PROCESS[processMessage / processReaction / processAction]
    end

    subgraph "ConversationRouter"
        RECORD --> MAP[(Thread → Timestamp Map)]
        CHECK -.->|query| MAP
    end
```

## Conversation Routing Flow

When the human operator replies from the Business App, the bot pauses for a configurable window. This prevents conflicts where both the human and bot respond to the same customer.

```mermaid
sequenceDiagram
    participant C as Customer
    participant WA as WhatsApp Platform
    participant Bot as Cloud API (Bot)
    participant App as Business App (Human)
    participant R as ConversationRouter

    Note over Bot,R: Normal mode — bot handles messages

    C->>WA: "Hi, I need help"
    WA->>Bot: webhook (messages)
    Bot->>R: isHumanActive(thread)?
    R-->>Bot: false
    Bot->>WA: "How can I help?"
    WA->>C: Bot reply delivered

    Note over Bot,R: Human takes over from the app

    C->>WA: "I want to speak to a person"
    WA->>Bot: webhook (messages)
    WA->>App: message appears
    App->>WA: "Hi, I'm here to help!"
    WA->>Bot: webhook (smb_message_echoes)
    Bot->>R: recordHumanReply(thread)

    Note over R: TTL window starts (default 30min)

    C->>WA: "Great, thanks!"
    WA->>Bot: webhook (messages)
    Bot->>R: isHumanActive(thread)?
    R-->>Bot: true (within TTL)
    Bot-->>Bot: Suppress — don't respond

    Note over R: After TTL expires...

    C->>WA: "One more question"
    WA->>Bot: webhook (messages)
    Bot->>R: isHumanActive(thread)?
    R-->>Bot: false (TTL expired)
    Bot->>WA: "Sure, what's your question?"
    WA->>C: Bot reply delivered
```

## History Sync (Onboarding)

When a phone number is first connected in coexistence mode, up to 6 months of historical messages can be synced from the Business App to the API side.

```mermaid
sequenceDiagram
    participant App as Business App
    participant Meta as Meta Platform
    participant Adapter as CoexistenceAdapter
    participant Handler as onHistorySync

    Note over App,Meta: Coexistence onboarding begins

    Meta->>Adapter: history webhook (chunk 1, progress: 33%)
    Adapter->>Handler: HistorySyncEvent (threads, chunkMeta)
    Handler-->>Handler: Import messages to state

    Meta->>Adapter: history webhook (chunk 2, progress: 66%)
    Adapter->>Handler: HistorySyncEvent (threads, chunkMeta)

    Meta->>Adapter: history webhook (chunk 3, progress: 100%)
    Adapter->>Handler: HistorySyncEvent (threads, chunkMeta)

    Note over Adapter: Historical sync complete
```

## Installation

```bash
pnpm add @chat-adapter/whatsapp-coexistence
```

## Quick Start

```typescript
import { Chat } from "chat";
import { createWhatsAppCoexistenceAdapter } from "@chat-adapter/whatsapp-coexistence";
import { MemoryState } from "@chat-adapter/state-memory";

const chat = new Chat({
  userName: "my-bot",
  adapters: {
    whatsapp: createWhatsAppCoexistenceAdapter({
      // Pause bot for 30 minutes after human replies from the app
      humanTakeoverTtlMs: 30 * 60 * 1000,

      // Called when the human sends a message from the Business App
      onMessageEcho: (event) => {
        console.log(`Human replied to ${event.threadId}:`, event.echo.text?.body);
      },

      // Called during onboarding to import historical messages
      onHistorySync: (event) => {
        console.log(`Syncing ${event.threads.length} threads (${event.chunkMeta.progress}%)`);
        for (const thread of event.threads) {
          // Import thread.messages into your state adapter
        }
      },

      // Called when contacts sync from the Business App
      onContactSync: (event) => {
        console.log(`Synced ${event.contacts.length} contacts`);
      },
    }),
  },
  state: new MemoryState(),
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accessToken` | `string` | `env.WHATSAPP_ACCESS_TOKEN` | Cloud API access token |
| `appSecret` | `string` | `env.WHATSAPP_APP_SECRET` | App secret for webhook signature verification |
| `phoneNumberId` | `string` | `env.WHATSAPP_PHONE_NUMBER_ID` | Business phone number ID |
| `verifyToken` | `string` | `env.WHATSAPP_VERIFY_TOKEN` | Webhook verification token |
| `humanTakeoverTtlMs` | `number` | `1800000` (30min) | How long to suppress bot after human replies |
| `onMessageEcho` | `function` | — | Callback for Business App message echoes |
| `onHistorySync` | `function` | — | Callback for historical message import |
| `onContactSync` | `function` | — | Callback for contact sync |
| `shouldBotRespond` | `function` | — | Custom routing function (overrides TTL logic) |

## Custom Routing

For advanced use cases (CRM integration, agent assignment queues, business hours), provide a `shouldBotRespond` function:

```typescript
const adapter = createWhatsAppCoexistenceAdapter({
  shouldBotRespond: async (context) => {
    // Always let bot handle outside business hours
    const hour = new Date().getHours();
    if (hour < 9 || hour >= 17) return true;

    // During business hours, defer to human if they replied recently
    if (context.msSinceHumanReply < 60 * 60 * 1000) return false;

    // Otherwise bot handles it
    return true;
  },
});
```

The `RoutingContext` provides:

| Field | Type | Description |
|-------|------|-------------|
| `threadId` | `string` | Thread ID for the conversation |
| `customerWaId` | `string` | Customer's WhatsApp phone number |
| `phoneNumberId` | `string` | Business phone number ID |
| `lastHumanReplyAt` | `Date \| null` | When the human last replied, or null |
| `msSinceHumanReply` | `number` | Milliseconds since last human reply, or `Infinity` |

## Manual Thread Control

Access the `ConversationRouter` to manually control thread ownership:

```typescript
const adapter = createWhatsAppCoexistenceAdapter({ /* ... */ });
const router = adapter.getRouter();

// Check if human is currently handling a thread
router.isHumanActive(threadId); // boolean

// Release a thread back to the bot (e.g., human clicked "Transfer to bot")
router.releaseThread(threadId);

// Check when human last replied
router.getLastHumanReplyAt(threadId); // Date | null
router.getMsSinceHumanReply(threadId); // number | Infinity
```

## Webhook Setup

Your webhook endpoint needs to handle both standard and coexistence events. Subscribe to these webhook fields in your Meta App Dashboard:

- `messages` (standard — inbound customer messages)
- `smb_message_echoes` (coexistence — echoes from Business App)
- `smb_app_state_sync` (coexistence — contact sync)

```typescript
// Next.js App Router example
import { after } from "next/server";

export async function GET(request: Request) {
  return chat.webhooks.whatsapp(request);
}

export async function POST(request: Request) {
  return chat.webhooks.whatsapp(request, {
    waitUntil: (p) => after(() => p),
  });
}
```

For the `history` webhook (sent to the partner endpoint during onboarding):

```typescript
export async function POST(request: Request) {
  const payload = await request.json();

  if (payload.event === "history") {
    const adapter = chat.adapters.whatsapp as WhatsAppCoexistenceAdapter;
    await adapter.handleHistoryWebhook(payload);
    return new Response("ok", { status: 200 });
  }

  // Handle other partner webhooks...
}
```

## Comparison with Standard Adapter

```mermaid
graph LR
    subgraph "Standard WhatsApp Adapter"
        S_IN[Customer Message] --> S_BOT[Bot Responds]
    end

    subgraph "Coexistence Adapter"
        C_IN[Customer Message] --> C_CHECK{Human Active?}
        C_CHECK -->|No| C_BOT[Bot Responds]
        C_CHECK -->|Yes| C_SKIP[Suppress Bot]
        C_ECHO[Human Sends from App] --> C_TRACK[Track Activity]
        C_TRACK --> C_CHECK
    end
```

| Feature | Standard | Coexistence |
|---------|----------|-------------|
| Cloud API messaging | Yes | Yes |
| Business App alongside | No | Yes |
| Message echo detection | No | Yes |
| Conversation routing | No | Yes (TTL + custom) |
| History import | No | Yes |
| Contact sync | No | Yes |
| Manual thread control | No | Yes |

## Limitations

- **In-memory routing state**: The `ConversationRouter` stores state in memory. For multi-instance deployments, you'll need to implement a shared store (Redis, etc.) or use the `shouldBotRespond` callback with your own persistence.
- **No platform-level handoff**: Meta does not provide a built-in conversation ownership API. Routing is entirely application-level.
- **Regional restrictions**: Coexistence is not available in the EU, EEA, UK, or for numbers from certain countries. See [Meta's documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) for details.
- **Status webhook reliability**: Some developers report that delivery/read status webhooks may not fire reliably in coexistence mode.

## References

- [Meta: Onboarding Business App Users (Coexistence)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
- [Meta: smb_message_echoes Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/)
- [Meta: smb_app_state_sync Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync/)
- [Meta: Cloud API Webhook Components](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components/)
