# @chat-adapter/whatsapp-coexistence

WhatsApp Coexistence adapter for the [Vercel Chat SDK](https://github.com/vercel/chat). Run the **WhatsApp Business App** and **Cloud API** on the same phone number simultaneously.

## Install

```bash
pnpm add @chat-adapter/whatsapp-coexistence
```

## Environment Variables

```bash
FACEBOOK_APP_ID=your-app-id               # Meta App Dashboard → Settings → Basic
WHATSAPP_APP_SECRET=your-app-secret        # Meta App Dashboard → Settings → Basic
WHATSAPP_ACCESS_TOKEN=your-access-token    # From Embedded Signup or System User
WHATSAPP_PHONE_NUMBER_ID=your-phone-id     # From WABA dashboard or fetchWABAInfo()
WHATSAPP_VERIFY_TOKEN=your-verify-token    # You generate this (see below)
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
      humanTakeoverTtlMs: 30 * 60 * 1000, // pause bot for 30min after human replies
      onMessageEcho: (event) => {
        console.log("Human replied from app:", event.echo.text?.body);
      },
    }),
  },
  state: new MemoryState(),
});

// Register handlers as usual
chat.onNewMessage("whatsapp", async ({ thread, message }) => {
  await thread.post({ markdown: `You said: ${message.text}` });
});
```

## Generate a Verify Token

```typescript
import { generateVerifyToken } from "@chat-adapter/whatsapp-coexistence";

console.log(generateVerifyToken());
// Set this as WHATSAPP_VERIFY_TOKEN and in Meta App Dashboard → Webhooks
```

## Validate Environment

```typescript
import { validateEnv } from "@chat-adapter/whatsapp-coexistence";

const env = validateEnv(); // throws listing any missing vars
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Architecture](./docs/architecture.md) | How coexistence works, adapter design, comparison with standard adapter |
| [Authentication](./docs/auth.md) | Auth flows, token lifecycle, Embedded Signup, credential management |
| [Conversation Routing](./docs/routing.md) | TTL-based routing, custom routing, manual thread control, multi-instance |
| [Webhooks](./docs/webhooks.md) | Webhook setup, history sync, message echoes, contact sync |

## References

- [Meta: Coexistence Onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
- [Meta: smb_message_echoes Webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/)
- [Meta: Cloud API Get Started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
