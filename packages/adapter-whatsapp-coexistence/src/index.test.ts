import { createHmac } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createWhatsAppCoexistenceAdapter,
  WhatsAppCoexistenceAdapter,
} from "./index";
import { ConversationRouter } from "./routing";
import type {
  CoexistenceAdapterConfig,
  HistoryWebhookPayload,
} from "./types";

// =============================================================================
// Helpers
// =============================================================================

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function createTestConfig(
  overrides?: Partial<CoexistenceAdapterConfig>
): CoexistenceAdapterConfig {
  return {
    accessToken: "test-token",
    appSecret: "test-secret",
    phoneNumberId: "123456789",
    verifyToken: "test-verify-token",
    userName: "test-bot",
    logger: mockLogger,
    ...overrides,
  };
}

function createTestAdapter(
  overrides?: Partial<CoexistenceAdapterConfig>
): WhatsAppCoexistenceAdapter {
  return new WhatsAppCoexistenceAdapter(createTestConfig(overrides));
}

function makeSignature(body: string, secret = "test-secret"): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeSignedRequest(
  payload: unknown,
  secret = "test-secret"
): Request {
  const body = JSON.stringify(payload);
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": makeSignature(body, secret),
      "content-type": "application/json",
    },
    body,
  });
}

const mockChat = {
  processMessage: vi.fn(),
  processReaction: vi.fn(),
  processAction: vi.fn(),
  processModalSubmit: vi.fn(),
  processModalClose: vi.fn(),
  processSlashCommand: vi.fn(),
  processMemberJoinedChannel: vi.fn(),
  getState: vi.fn(),
  getUserName: () => "test-bot",
  getLogger: () => mockLogger,
};

// =============================================================================
// ConversationRouter
// =============================================================================

describe("ConversationRouter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should not report human active when no reply recorded", () => {
    const router = new ConversationRouter(30_000);
    expect(router.isHumanActive("thread-1")).toBe(false);
    router.dispose();
  });

  it("should report human active after recording a reply", () => {
    const router = new ConversationRouter(30_000);
    router.recordHumanReply("thread-1");
    expect(router.isHumanActive("thread-1")).toBe(true);
    router.dispose();
  });

  it("should expire human activity after TTL", () => {
    vi.useFakeTimers();
    const router = new ConversationRouter(5_000);
    router.recordHumanReply("thread-1");
    expect(router.isHumanActive("thread-1")).toBe(true);

    vi.advanceTimersByTime(6_000);
    expect(router.isHumanActive("thread-1")).toBe(false);
    router.dispose();
    vi.useRealTimers();
  });

  it("should return correct lastHumanReplyAt", () => {
    const router = new ConversationRouter(30_000);
    expect(router.getLastHumanReplyAt("thread-1")).toBeNull();

    const before = Date.now();
    router.recordHumanReply("thread-1");
    const after = Date.now();

    const replyAt = router.getLastHumanReplyAt("thread-1");
    expect(replyAt).not.toBeNull();
    expect(replyAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(replyAt!.getTime()).toBeLessThanOrEqual(after);
    router.dispose();
  });

  it("should return Infinity for msSinceHumanReply when no reply", () => {
    const router = new ConversationRouter(30_000);
    expect(router.getMsSinceHumanReply("thread-1")).toBe(
      Number.POSITIVE_INFINITY
    );
    router.dispose();
  });

  it("should release a thread", () => {
    const router = new ConversationRouter(30_000);
    router.recordHumanReply("thread-1");
    expect(router.isHumanActive("thread-1")).toBe(true);

    router.releaseThread("thread-1");
    expect(router.isHumanActive("thread-1")).toBe(false);
    router.dispose();
  });
});

// =============================================================================
// Webhook verification (GET) — delegated to base adapter
// =============================================================================

describe("handleWebhook - GET verification", () => {
  it("should pass valid verification challenge", async () => {
    const adapter = createTestAdapter();
    const url =
      "https://example.com/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge123";
    const request = new Request(url, { method: "GET" });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge123");
  });

  it("should reject invalid verify token", async () => {
    const adapter = createTestAdapter();
    const url =
      "https://example.com/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123";
    const request = new Request(url, { method: "GET" });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(403);
  });
});

// =============================================================================
// Signature verification
// =============================================================================

describe("handleWebhook - POST signature verification", () => {
  it("should reject missing signature", async () => {
    const adapter = createTestAdapter();
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry: [] }),
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(401);
  });

  it("should reject bad signature", async () => {
    const adapter = createTestAdapter();
    const body = JSON.stringify({ entry: [] });
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=bad",
        "content-type": "application/json",
      },
      body,
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(401);
  });

  it("should reject invalid JSON", async () => {
    const adapter = createTestAdapter();
    const body = "not-json";
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": makeSignature(body),
        "content-type": "application/json",
      },
      body,
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(400);
  });
});

// =============================================================================
// smb_message_echoes handling
// =============================================================================

describe("handleWebhook - smb_message_echoes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should record human activity and call onMessageEcho", async () => {
    const onMessageEcho = vi.fn();
    const adapter = createTestAdapter({ onMessageEcho });

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                message_echoes: [
                  {
                    from: "+15551234567",
                    to: "15559876543",
                    id: "wamid.echo1",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "Hello from the app!" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await adapter.handleWebhook(makeSignedRequest(payload));
    expect(response.status).toBe(200);

    // Check echo callback was called
    expect(onMessageEcho).toHaveBeenCalledOnce();
    const event = onMessageEcho.mock.calls[0][0];
    expect(event.threadId).toBe("whatsapp:123456789:15559876543");
    expect(event.echo.text.body).toBe("Hello from the app!");

    // Check router recorded the activity
    expect(
      adapter.getRouter().isHumanActive("whatsapp:123456789:15559876543")
    ).toBe(true);
  });

  it("should suppress bot processing when human is active", async () => {
    const adapter = createTestAdapter();
    await adapter.initialize(mockChat as never);

    // First: human replies from the app
    const echoPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                message_echoes: [
                  {
                    from: "+15551234567",
                    to: "15559876543",
                    id: "wamid.echo2",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "I'll handle this" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await adapter.handleWebhook(makeSignedRequest(echoPayload));

    // Then: customer sends a message
    const messagePayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                contacts: [
                  { profile: { name: "Customer" }, wa_id: "15559876543" },
                ],
                messages: [
                  {
                    id: "wamid.cust1",
                    from: "15559876543",
                    timestamp: "1700000010",
                    type: "text",
                    text: { body: "Thanks!" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const response = await adapter.handleWebhook(
      makeSignedRequest(messagePayload)
    );
    expect(response.status).toBe(200);

    // Bot should NOT have processed the message
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("should process messages when human is NOT active", async () => {
    const adapter = createTestAdapter();
    await adapter.initialize(mockChat as never);

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                contacts: [
                  { profile: { name: "Customer" }, wa_id: "15559876543" },
                ],
                messages: [
                  {
                    id: "wamid.cust2",
                    from: "15559876543",
                    timestamp: "1700000020",
                    type: "text",
                    text: { body: "Hello bot" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await adapter.handleWebhook(makeSignedRequest(payload));
    expect(response.status).toBe(200);
    expect(mockChat.processMessage).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// Custom routing
// =============================================================================

describe("handleWebhook - custom shouldBotRespond", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should use custom routing function", async () => {
    const shouldBotRespond = vi.fn().mockReturnValue(false);
    const adapter = createTestAdapter({ shouldBotRespond });
    await adapter.initialize(mockChat as never);

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                messages: [
                  {
                    id: "wamid.route1",
                    from: "15559876543",
                    timestamp: "1700000030",
                    type: "text",
                    text: { body: "Should I be routed?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await adapter.handleWebhook(makeSignedRequest(payload));
    expect(shouldBotRespond).toHaveBeenCalledOnce();

    const context = shouldBotRespond.mock.calls[0][0];
    expect(context.threadId).toBe("whatsapp:123456789:15559876543");
    expect(context.customerWaId).toBe("15559876543");
    expect(context.msSinceHumanReply).toBe(Number.POSITIVE_INFINITY);

    // Bot was told not to respond
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("should process when custom routing returns true", async () => {
    const shouldBotRespond = vi.fn().mockReturnValue(true);
    const adapter = createTestAdapter({ shouldBotRespond });
    await adapter.initialize(mockChat as never);

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                messages: [
                  {
                    id: "wamid.route2",
                    from: "15559876543",
                    timestamp: "1700000040",
                    type: "text",
                    text: { body: "Route me to bot" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await adapter.handleWebhook(makeSignedRequest(payload));
    expect(mockChat.processMessage).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// smb_app_state_sync handling
// =============================================================================

describe("handleWebhook - smb_app_state_sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should call onContactSync handler", async () => {
    const onContactSync = vi.fn();
    const adapter = createTestAdapter({ onContactSync });

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "smb_app_state_sync",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                contacts: [
                  { wa_id: "15559876543", profile: { name: "Alice" } },
                  { wa_id: "15559876544", profile: { name: "Bob" } },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await adapter.handleWebhook(makeSignedRequest(payload));
    expect(response.status).toBe(200);

    expect(onContactSync).toHaveBeenCalledOnce();
    const event = onContactSync.mock.calls[0][0];
    expect(event.phoneNumberId).toBe("123456789");
    expect(event.contacts).toHaveLength(2);
    expect(event.contacts[0].profile.name).toBe("Alice");
  });
});

// =============================================================================
// History webhook
// =============================================================================

describe("handleHistoryWebhook", () => {
  it("should call onHistorySync handler for each chunk", async () => {
    const onHistorySync = vi.fn();
    const adapter = createTestAdapter({ onHistorySync });

    const payload: HistoryWebhookPayload = {
      id: "event-1",
      event: "history",
      data: {
        id: "waba-123",
        messaging_product: "whatsapp",
        metadata: {
          display_phone_number: "+15551234567",
          phone_number_id: "123456789",
        },
        history: [
          {
            metadata: {
              phase: "initial",
              chunk_order: "1",
              progress: "50",
            },
            threads: [
              {
                id: "15559876543",
                messages: [
                  {
                    from: "+15551234567",
                    to: "15559876543",
                    id: "wamid.hist1",
                    timestamp: "1699900000",
                    type: "text",
                    text: { body: "Historical message 1" },
                  },
                ],
              },
            ],
          },
          {
            metadata: {
              phase: "initial",
              chunk_order: "2",
              progress: "100",
            },
            threads: [
              {
                id: "15559876544",
                messages: [
                  {
                    from: "+15551234567",
                    to: "15559876544",
                    id: "wamid.hist2",
                    timestamp: "1699900100",
                    type: "text",
                    text: { body: "Historical message 2" },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    await adapter.handleHistoryWebhook(payload);

    expect(onHistorySync).toHaveBeenCalledTimes(2);
    expect(onHistorySync.mock.calls[0][0].chunkMeta.chunk_order).toBe("1");
    expect(onHistorySync.mock.calls[1][0].chunkMeta.progress).toBe("100");
    expect(onHistorySync.mock.calls[0][0].threads[0].messages[0].text.body).toBe(
      "Historical message 1"
    );
  });

  it("should skip when no onHistorySync handler configured", async () => {
    const adapter = createTestAdapter();
    const payload: HistoryWebhookPayload = {
      id: "event-2",
      event: "history",
      data: {
        id: "waba-123",
        messaging_product: "whatsapp",
        metadata: {
          display_phone_number: "+15551234567",
          phone_number_id: "123456789",
        },
        history: [],
      },
    };

    // Should not throw
    await adapter.handleHistoryWebhook(payload);
  });
});

// =============================================================================
// Mixed payload (echoes + messages in same webhook)
// =============================================================================

describe("handleWebhook - mixed coexistence payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle echoes and suppress messages in same payload", async () => {
    const onMessageEcho = vi.fn();
    const adapter = createTestAdapter({ onMessageEcho });
    await adapter.initialize(mockChat as never);

    // Payload with both an echo and a customer message for the same thread
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                message_echoes: [
                  {
                    from: "+15551234567",
                    to: "15559876543",
                    id: "wamid.echo-mixed",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "Human handling" },
                  },
                ],
              },
            },
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                messages: [
                  {
                    id: "wamid.cust-mixed",
                    from: "15559876543",
                    timestamp: "1700000005",
                    type: "text",
                    text: { body: "Customer reply" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await adapter.handleWebhook(makeSignedRequest(payload));
    expect(response.status).toBe(200);

    // Echo was processed
    expect(onMessageEcho).toHaveBeenCalledOnce();

    // Message was suppressed because echo was processed first
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Router manual release
// =============================================================================

describe("getRouter - manual thread release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow bot to respond after manual release", async () => {
    const adapter = createTestAdapter();
    await adapter.initialize(mockChat as never);

    // Human takes over
    const echoPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                message_echoes: [
                  {
                    from: "+15551234567",
                    to: "15559876543",
                    id: "wamid.echo-release",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "Taking over" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await adapter.handleWebhook(makeSignedRequest(echoPayload));
    expect(
      adapter.getRouter().isHumanActive("whatsapp:123456789:15559876543")
    ).toBe(true);

    // Manually release
    adapter.getRouter().releaseThread("whatsapp:123456789:15559876543");

    // Now customer message should be processed
    const messagePayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551234567",
                  phone_number_id: "123456789",
                },
                contacts: [
                  { profile: { name: "Customer" }, wa_id: "15559876543" },
                ],
                messages: [
                  {
                    id: "wamid.cust-released",
                    from: "15559876543",
                    timestamp: "1700000050",
                    type: "text",
                    text: { body: "Bot can respond now" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const response = await adapter.handleWebhook(
      makeSignedRequest(messagePayload)
    );
    expect(response.status).toBe(200);
    expect(mockChat.processMessage).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// Delegated methods
// =============================================================================

describe("delegated methods", () => {
  it("should encode/decode thread IDs", () => {
    const adapter = createTestAdapter();
    const encoded = adapter.encodeThreadId({
      phoneNumberId: "123456789",
      userWaId: "15551234567",
    });
    expect(encoded).toBe("whatsapp:123456789:15551234567");

    const decoded = adapter.decodeThreadId(encoded);
    expect(decoded).toEqual({
      phoneNumberId: "123456789",
      userWaId: "15551234567",
    });
  });

  it("should report all threads as DMs", () => {
    const adapter = createTestAdapter();
    expect(adapter.isDM("whatsapp:123456789:15551234567")).toBe(true);
  });

  it("should return name as 'whatsapp'", () => {
    const adapter = createTestAdapter();
    expect(adapter.name).toBe("whatsapp");
  });

  it("should have persistMessageHistory true", () => {
    const adapter = createTestAdapter();
    expect(adapter.persistMessageHistory).toBe(true);
  });
});

// =============================================================================
// Factory function
// =============================================================================

describe("createWhatsAppCoexistenceAdapter", () => {
  it("should throw when accessToken is missing", () => {
    expect(() =>
      createWhatsAppCoexistenceAdapter({
        appSecret: "secret",
        phoneNumberId: "123",
        verifyToken: "verify",
      })
    ).toThrow(/accessToken/i);
  });

  it("should throw when appSecret is missing", () => {
    expect(() =>
      createWhatsAppCoexistenceAdapter({
        accessToken: "token",
        phoneNumberId: "123",
        verifyToken: "verify",
      })
    ).toThrow(/appSecret/i);
  });

  it("should throw when phoneNumberId is missing", () => {
    expect(() =>
      createWhatsAppCoexistenceAdapter({
        accessToken: "token",
        appSecret: "secret",
        verifyToken: "verify",
      })
    ).toThrow(/phoneNumberId/i);
  });

  it("should throw when verifyToken is missing", () => {
    expect(() =>
      createWhatsAppCoexistenceAdapter({
        accessToken: "token",
        appSecret: "secret",
        phoneNumberId: "123",
      })
    ).toThrow(/verifyToken/i);
  });

  it("should create adapter with all required config", () => {
    const adapter = createWhatsAppCoexistenceAdapter({
      accessToken: "token",
      appSecret: "secret",
      phoneNumberId: "123",
      verifyToken: "verify",
    });
    expect(adapter).toBeInstanceOf(WhatsAppCoexistenceAdapter);
  });

  it("should use environment variables as fallback", () => {
    const originalEnv = { ...process.env };
    process.env.WHATSAPP_ACCESS_TOKEN = "env-token";
    process.env.WHATSAPP_APP_SECRET = "env-secret";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "env-phone";
    process.env.WHATSAPP_VERIFY_TOKEN = "env-verify";

    try {
      const adapter = createWhatsAppCoexistenceAdapter();
      expect(adapter).toBeInstanceOf(WhatsAppCoexistenceAdapter);
    } finally {
      for (const key of [
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_APP_SECRET",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_VERIFY_TOKEN",
      ]) {
        if (key in originalEnv) {
          process.env[key] = originalEnv[key];
        } else {
          delete process.env[key];
        }
      }
    }
  });
});
