/**
 * Integration tests for credential store + adapter multi-number scenarios.
 *
 * Covers:
 * 1. Single-number mode with env vars (StaticCredentialStore)
 * 2. Multi-number mode stores and retrieves (StateCredentialStore)
 * 3. Webhook routes to correct adapter by phone_number_id
 * 4. OAuth callback persists credentials to state adapter
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWhatsAppCoexistenceAdapter,
  StateCredentialStore,
  StaticCredentialStore,
  WhatsAppCoexistenceAdapter,
} from "./index";
import type {
  CredentialStore,
  KeyValueStore,
  PhoneNumberCredentials,
} from "./credential-store";

// ── Helpers ─────────────────────────────────────────────────────────

function createMockKVStore(): KeyValueStore & { _data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (data.get(key) as T) ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    _data: data,
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

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

function makeSignedRequest(
  payload: unknown,
  secret = "test-secret"
): Request {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": signature,
      "content-type": "application/json",
    },
    body,
  });
}

function createAdapterForCreds(
  creds: PhoneNumberCredentials
): WhatsAppCoexistenceAdapter {
  return createWhatsAppCoexistenceAdapter({
    accessToken: creds.accessToken,
    appSecret: "test-secret",
    phoneNumberId: creds.phoneNumberId,
    verifyToken: creds.verifyToken,
    logger: mockLogger,
  });
}

// =============================================================================
// 1. Single-number mode — env vars via StaticCredentialStore
// =============================================================================

describe("single-number mode with StaticCredentialStore", () => {
  it("should provide credentials for the configured number", async () => {
    const store = new StaticCredentialStore({
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });

    const creds = await store.get("111");
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe("token-A");

    // Create adapter from these credentials
    const adapter = createAdapterForCreds(creds!);
    expect(adapter).toBeInstanceOf(WhatsAppCoexistenceAdapter);
    expect(adapter.name).toBe("whatsapp");
  });

  it("should return null for unregistered numbers", async () => {
    const store = new StaticCredentialStore({
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });

    expect(await store.get("999")).toBeNull();
  });

  it("should create a working adapter from env-backed credentials", async () => {
    const store = new StaticCredentialStore({
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });

    const creds = await store.get("111");
    const adapter = createAdapterForCreds(creds!);
    await adapter.initialize(mockChat as never);

    // Verify GET challenge works
    const url =
      "https://example.com/webhook?hub.mode=subscribe&hub.verify_token=verify-A&hub.challenge=test123";
    const response = await adapter.handleWebhook(
      new Request(url, { method: "GET" })
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test123");
  });
});

// =============================================================================
// 2. Multi-number mode — StateCredentialStore stores and retrieves
// =============================================================================

describe("multi-number mode with StateCredentialStore", () => {
  it("should store and retrieve credentials for multiple numbers", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
      displayPhoneNumber: "+1 555 111 1111",
      wabaId: "waba-1",
    });

    await store.set("222", {
      accessToken: "token-B",
      phoneNumberId: "222",
      verifyToken: "verify-B",
      displayPhoneNumber: "+1 555 222 2222",
      wabaId: "waba-1",
    });

    // Both numbers registered
    const list = await store.list();
    expect(list).toEqual(["111", "222"]);

    // Retrieve individually
    const credsA = await store.get("111");
    expect(credsA!.accessToken).toBe("token-A");
    expect(credsA!.displayPhoneNumber).toBe("+1 555 111 1111");

    const credsB = await store.get("222");
    expect(credsB!.accessToken).toBe("token-B");
  });

  it("should create separate adapters per number", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });
    await store.set("222", {
      accessToken: "token-B",
      phoneNumberId: "222",
      verifyToken: "verify-B",
    });

    const credsA = await store.get("111");
    const credsB = await store.get("222");

    const adapterA = createAdapterForCreds(credsA!);
    const adapterB = createAdapterForCreds(credsB!);

    // Both are distinct instances
    expect(adapterA).not.toBe(adapterB);
    expect(adapterA).toBeInstanceOf(WhatsAppCoexistenceAdapter);
    expect(adapterB).toBeInstanceOf(WhatsAppCoexistenceAdapter);

    // Each encodes thread IDs with its own phone number
    const threadA = adapterA.encodeThreadId({
      phoneNumberId: "111",
      userWaId: "customer-1",
    });
    const threadB = adapterB.encodeThreadId({
      phoneNumberId: "222",
      userWaId: "customer-1",
    });

    expect(threadA).toBe("whatsapp:111:customer-1");
    expect(threadB).toBe("whatsapp:222:customer-1");
  });

  it("should update credentials without duplicating index entries", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "old-token",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });

    // Update with new token (e.g., after token refresh)
    await store.set("111", {
      accessToken: "new-token",
      phoneNumberId: "111",
      verifyToken: "verify-A",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 60,
    });

    expect(await store.list()).toEqual(["111"]);
    const creds = await store.get("111");
    expect(creds!.accessToken).toBe("new-token");
    expect(creds!.tokenExpiresAt).toBeGreaterThan(0);
  });

  it("should remove a number cleanly", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });
    await store.set("222", {
      accessToken: "token-B",
      phoneNumberId: "222",
      verifyToken: "verify-B",
    });

    await store.delete("111");

    expect(await store.get("111")).toBeNull();
    expect(await store.list()).toEqual(["222"]);
    expect(await store.get("222")).not.toBeNull();
  });
});

// =============================================================================
// 3. Webhook routes to correct adapter by phone_number_id
// =============================================================================

describe("webhook routing by phone_number_id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should route webhooks to the adapter matching phone_number_id", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });
    await store.set("222", {
      accessToken: "token-B",
      phoneNumberId: "222",
      verifyToken: "verify-B",
    });

    // Simulate multi-number routing: extract phone_number_id from payload,
    // look up credentials, create/get adapter, handle webhook
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15551111111",
                  phone_number_id: "111",
                },
                contacts: [
                  { profile: { name: "Customer" }, wa_id: "customer-1" },
                ],
                messages: [
                  {
                    id: "wamid.1",
                    from: "customer-1",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "Hello" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    // Extract phone_number_id (same logic as webhook route)
    const phoneNumberId =
      payload.entry[0].changes[0].value.metadata.phone_number_id;
    expect(phoneNumberId).toBe("111");

    // Look up credentials
    const creds = await store.get(phoneNumberId);
    expect(creds).not.toBeNull();
    expect(creds!.phoneNumberId).toBe("111");

    // Create adapter and handle
    const adapter = createAdapterForCreds(creds!);
    await adapter.initialize(mockChat as never);

    const response = await adapter.handleWebhook(makeSignedRequest(payload));
    expect(response.status).toBe(200);

    // Verify the message was processed by the correct adapter
    expect(mockChat.processMessage).toHaveBeenCalledOnce();
  });

  it("should return null for unregistered phone numbers", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });

    // Webhook for unregistered number
    const creds = await store.get("999");
    expect(creds).toBeNull();
    // In the real webhook route, this returns 404
  });

  it("should verify GET challenge with matching verify token", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "secret-verify-111",
    });
    await store.set("222", {
      accessToken: "token-B",
      phoneNumberId: "222",
      verifyToken: "secret-verify-222",
    });

    // Simulate multi-number GET verification: check all registered tokens
    const hubToken = "secret-verify-222";
    const numbers = await store.list();

    let matched = false;
    for (const id of numbers) {
      const creds = await store.get(id);
      if (creds?.verifyToken === hubToken) {
        matched = true;
        break;
      }
    }

    expect(matched).toBe(true);
  });

  it("should reject GET challenge with unknown verify token", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "secret-verify-111",
    });

    const hubToken = "wrong-token";
    const numbers = await store.list();

    let matched = false;
    for (const id of numbers) {
      const creds = await store.get(id);
      if (creds?.verifyToken === hubToken) {
        matched = true;
        break;
      }
    }

    expect(matched).toBe(false);
  });
});

// =============================================================================
// 4. OAuth callback persists credentials to state adapter
// =============================================================================

describe("OAuth callback credential persistence", () => {
  it("should persist credentials from signup flow to credential store", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    // Simulate what the OAuth callback does after token exchange
    const signupResult = {
      accessToken: "EAAlong-lived-token-abc",
      expiresIn: 5184000, // 60 days
      phoneNumbers: [
        { id: "111", display_phone_number: "+1 555 111 1111", verified_name: "My Business" },
        { id: "222", display_phone_number: "+1 555 222 2222", verified_name: "My Business" },
      ],
      wabaId: "waba-123",
      verifyToken: "generated-verify-token",
    };

    const tokenExpiresAt = Math.floor(Date.now() / 1000) + signupResult.expiresIn;

    // Store credentials for each discovered phone number
    for (const phone of signupResult.phoneNumbers) {
      await store.set(phone.id, {
        accessToken: signupResult.accessToken,
        phoneNumberId: phone.id,
        verifyToken: signupResult.verifyToken,
        displayPhoneNumber: phone.display_phone_number,
        wabaId: signupResult.wabaId,
        tokenExpiresAt,
      });
    }

    // Verify both numbers are registered
    const numbers = await store.list();
    expect(numbers).toEqual(["111", "222"]);

    // Verify credentials are complete
    const creds1 = await store.get("111");
    expect(creds1).toEqual({
      accessToken: "EAAlong-lived-token-abc",
      phoneNumberId: "111",
      verifyToken: "generated-verify-token",
      displayPhoneNumber: "+1 555 111 1111",
      wabaId: "waba-123",
      tokenExpiresAt,
    });

    const creds2 = await store.get("222");
    expect(creds2!.phoneNumberId).toBe("222");
    expect(creds2!.displayPhoneNumber).toBe("+1 555 222 2222");
    expect(creds2!.accessToken).toBe(signupResult.accessToken);

    // Verify adapters can be created from stored credentials
    for (const id of numbers) {
      const creds = await store.get(id);
      const adapter = createAdapterForCreds(creds!);
      expect(adapter).toBeInstanceOf(WhatsAppCoexistenceAdapter);
    }
  });

  it("should handle token refresh by updating stored credentials", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    // Initial signup
    await store.set("111", {
      accessToken: "old-token",
      phoneNumberId: "111",
      verifyToken: "verify-A",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days left
    });

    // Token refresh (e.g., via extendToken)
    const newExpiry = Math.floor(Date.now() / 1000) + 86400 * 60; // 60 days
    const existing = await store.get("111");
    await store.set("111", {
      ...existing!,
      accessToken: "refreshed-token",
      tokenExpiresAt: newExpiry,
    });

    // Verify updated
    const updated = await store.get("111");
    expect(updated!.accessToken).toBe("refreshed-token");
    expect(updated!.tokenExpiresAt).toBe(newExpiry);
    expect(updated!.verifyToken).toBe("verify-A"); // unchanged

    // Still only one entry
    expect(await store.list()).toEqual(["111"]);
  });

  it("should support deregistering a phone number", async () => {
    const store = new StateCredentialStore(createMockKVStore());

    await store.set("111", {
      accessToken: "token-A",
      phoneNumberId: "111",
      verifyToken: "verify-A",
    });
    await store.set("222", {
      accessToken: "token-B",
      phoneNumberId: "222",
      verifyToken: "verify-B",
    });

    // Deregister number 111
    await store.delete("111");

    expect(await store.list()).toEqual(["222"]);
    expect(await store.get("111")).toBeNull();

    // Number 222 still works
    const creds = await store.get("222");
    const adapter = createAdapterForCreds(creds!);
    expect(adapter).toBeInstanceOf(WhatsAppCoexistenceAdapter);
  });
});
