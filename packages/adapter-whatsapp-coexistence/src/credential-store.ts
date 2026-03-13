/**
 * Credential storage for WhatsApp coexistence mode.
 *
 * Supports two modes:
 * - **Single-number** (`StaticCredentialStore`): credentials from env/config, read-only
 * - **Multi-number** (`StateCredentialStore`): credentials persisted via any Chat SDK
 *   state adapter (memory, redis, postgres, ioredis)
 *
 * The `StateCredentialStore` accepts a minimal `KeyValueStore` interface that all
 * Chat SDK `StateAdapter` implementations satisfy — no direct dependency on any
 * specific storage backend.
 */

/**
 * Minimal key-value store interface.
 *
 * All Chat SDK `StateAdapter` implementations (memory, redis, postgres, ioredis)
 * satisfy this interface via their `get`, `set`, and `delete` methods.
 */
export interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Credentials for a single WhatsApp phone number.
 */
export interface PhoneNumberCredentials {
  /** Cloud API access token */
  accessToken: string;
  /** Phone number ID from WABA */
  phoneNumberId: string;
  /** Human-readable phone number (e.g. "+1 555 123 4567") */
  displayPhoneNumber?: string;
  /** WhatsApp Business Account ID */
  wabaId?: string;
  /** Unix timestamp (seconds) when the token expires, or 0 for permanent tokens */
  tokenExpiresAt?: number;
}

/**
 * Interface for storing and retrieving per-number credentials.
 *
 * Implement this to use a custom storage backend, or use the provided
 * `StateCredentialStore` (works with any Chat SDK state adapter) or
 * `StaticCredentialStore` (reads from config, single-number only).
 */
export interface CredentialStore {
  /** Get credentials for a phone number. Returns null if not found. */
  get(phoneNumberId: string): Promise<PhoneNumberCredentials | null>;

  /** Store credentials for a phone number. */
  set(
    phoneNumberId: string,
    credentials: PhoneNumberCredentials
  ): Promise<void>;

  /** Remove credentials for a phone number. */
  delete(phoneNumberId: string): Promise<void>;

  /** List all registered phone number IDs. */
  list(): Promise<string[]>;
}

/**
 * Credential store backed by any Chat SDK `StateAdapter`.
 *
 * Works with `MemoryState`, `RedisState`, `PostgresState`, `IoRedisState`, etc.
 * Stores credentials as JSON via the state adapter's generic `get`/`set` methods.
 *
 * @example
 * ```typescript
 * import { createMemoryState } from "@chat-adapter/state-memory";
 * import { StateCredentialStore } from "@chat-adapter/whatsapp-coexistence";
 *
 * const state = createMemoryState();
 * const store = new StateCredentialStore(state);
 *
 * // Store credentials from Embedded Signup
 * await store.set("123456789", {
 *   accessToken: "EAA...",
 *   phoneNumberId: "123456789",
 * });
 *
 * // Retrieve later
 * const creds = await store.get("123456789");
 * ```
 */
export class StateCredentialStore implements CredentialStore {
  private readonly prefix: string;

  constructor(
    private readonly store: KeyValueStore,
    options?: { keyPrefix?: string }
  ) {
    this.prefix = options?.keyPrefix ?? "wa-coex:creds";
  }

  async get(phoneNumberId: string): Promise<PhoneNumberCredentials | null> {
    return this.store.get<PhoneNumberCredentials>(
      `${this.prefix}:${phoneNumberId}`
    );
  }

  async set(
    phoneNumberId: string,
    credentials: PhoneNumberCredentials
  ): Promise<void> {
    await this.store.set(
      `${this.prefix}:${phoneNumberId}`,
      credentials
    );

    // Maintain an index of all registered phone numbers
    const index =
      (await this.store.get<string[]>(`${this.prefix}:index`)) ?? [];
    if (!index.includes(phoneNumberId)) {
      index.push(phoneNumberId);
      await this.store.set(`${this.prefix}:index`, index);
    }
  }

  async delete(phoneNumberId: string): Promise<void> {
    await this.store.delete(`${this.prefix}:${phoneNumberId}`);

    const index =
      (await this.store.get<string[]>(`${this.prefix}:index`)) ?? [];
    const filtered = index.filter((id) => id !== phoneNumberId);
    await this.store.set(`${this.prefix}:index`, filtered);
  }

  async list(): Promise<string[]> {
    return (
      (await this.store.get<string[]>(`${this.prefix}:index`)) ?? []
    );
  }
}

/**
 * Read-only credential store for single-number mode.
 *
 * Takes credentials from config or env vars. Attempting to write
 * throws an error — use `StateCredentialStore` for dynamic credentials.
 *
 * @example
 * ```typescript
 * const store = new StaticCredentialStore({
 *   accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
 *   phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
 * });
 * ```
 */
export class StaticCredentialStore implements CredentialStore {
  private readonly credentials: PhoneNumberCredentials;

  constructor(credentials: PhoneNumberCredentials) {
    this.credentials = credentials;
  }

  async get(
    phoneNumberId: string
  ): Promise<PhoneNumberCredentials | null> {
    return phoneNumberId === this.credentials.phoneNumberId
      ? this.credentials
      : null;
  }

  async set(): Promise<void> {
    throw new Error(
      "StaticCredentialStore is read-only. Use StateCredentialStore for dynamic credentials."
    );
  }

  async delete(): Promise<void> {
    throw new Error(
      "StaticCredentialStore is read-only. Use StateCredentialStore for dynamic credentials."
    );
  }

  async list(): Promise<string[]> {
    return [this.credentials.phoneNumberId];
  }
}
