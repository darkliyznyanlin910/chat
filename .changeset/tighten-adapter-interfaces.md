---
"chat": minor
"@chat-adapter/slack": patch
"@chat-adapter/github": patch
"@chat-adapter/linear": patch
---

Tighten Adapter & StateAdapter interfaces: make `channelIdFromThreadId` required, make `EphemeralMessage` generic over `TRawMessage`, add `satisfies Adapter` to mock adapter, migrate remaining adapters to shared error types
