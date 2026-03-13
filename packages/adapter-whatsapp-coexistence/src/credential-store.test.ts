import { describe, expect, it } from "vitest";
import {
  StateCredentialStore,
  StaticCredentialStore,
  type PhoneNumberCredentials,
} from "./credential-store";

// Minimal in-memory KeyValueStore for testing
function createMockStore() {
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

const testCreds: PhoneNumberCredentials = {
  accessToken: "EAAtest123",
  phoneNumberId: "111222333",
  displayPhoneNumber: "+1 555 000 1111",
  wabaId: "waba-456",
};

const testCreds2: PhoneNumberCredentials = {
  accessToken: "EAAtest456",
  phoneNumberId: "444555666",
};

// =============================================================================
// StateCredentialStore
// =============================================================================

describe("StateCredentialStore", () => {
  it("should store and retrieve credentials", async () => {
    const store = new StateCredentialStore(createMockStore());

    await store.set("111222333", testCreds);
    const result = await store.get("111222333");

    expect(result).toEqual(testCreds);
  });

  it("should return null for unknown phone number", async () => {
    const store = new StateCredentialStore(createMockStore());

    const result = await store.get("unknown");
    expect(result).toBeNull();
  });

  it("should maintain an index of phone numbers", async () => {
    const store = new StateCredentialStore(createMockStore());

    await store.set("111222333", testCreds);
    await store.set("444555666", testCreds2);

    const list = await store.list();
    expect(list).toEqual(["111222333", "444555666"]);
  });

  it("should not duplicate phone numbers in the index", async () => {
    const store = new StateCredentialStore(createMockStore());

    await store.set("111222333", testCreds);
    await store.set("111222333", { ...testCreds, accessToken: "updated" });

    const list = await store.list();
    expect(list).toEqual(["111222333"]);

    const result = await store.get("111222333");
    expect(result?.accessToken).toBe("updated");
  });

  it("should delete credentials and update index", async () => {
    const store = new StateCredentialStore(createMockStore());

    await store.set("111222333", testCreds);
    await store.set("444555666", testCreds2);
    await store.delete("111222333");

    expect(await store.get("111222333")).toBeNull();
    expect(await store.list()).toEqual(["444555666"]);
  });

  it("should use custom key prefix", async () => {
    const kv = createMockStore();
    const store = new StateCredentialStore(kv, { keyPrefix: "custom" });

    await store.set("111222333", testCreds);

    expect(kv._data.has("custom:111222333")).toBe(true);
    expect(kv._data.has("custom:index")).toBe(true);
  });

  it("should return empty list when no credentials stored", async () => {
    const store = new StateCredentialStore(createMockStore());
    expect(await store.list()).toEqual([]);
  });
});

// =============================================================================
// StaticCredentialStore
// =============================================================================

describe("StaticCredentialStore", () => {
  it("should return credentials for the configured phone number", async () => {
    const store = new StaticCredentialStore(testCreds);

    const result = await store.get("111222333");
    expect(result).toEqual(testCreds);
  });

  it("should return null for a different phone number", async () => {
    const store = new StaticCredentialStore(testCreds);

    const result = await store.get("999999999");
    expect(result).toBeNull();
  });

  it("should list the single configured phone number", async () => {
    const store = new StaticCredentialStore(testCreds);

    const list = await store.list();
    expect(list).toEqual(["111222333"]);
  });

  it("should throw on set (read-only)", async () => {
    const store = new StaticCredentialStore(testCreds);

    await expect(store.set("111222333", testCreds)).rejects.toThrow(
      /read-only/i
    );
  });

  it("should throw on delete (read-only)", async () => {
    const store = new StaticCredentialStore(testCreds);

    await expect(store.delete("111222333")).rejects.toThrow(/read-only/i);
  });
});
