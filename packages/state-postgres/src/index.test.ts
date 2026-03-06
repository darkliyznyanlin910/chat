import type { Logger } from "chat";
import { describe, expect, it, vi } from "vitest";
import { createPostgresState, PostgresStateAdapter } from "./index";

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("PostgresStateAdapter", () => {
  it("should export createPostgresState function", () => {
    expect(typeof createPostgresState).toBe("function");
  });

  it("should export PostgresStateAdapter class", () => {
    expect(typeof PostgresStateAdapter).toBe("function");
  });

  describe("createPostgresState", () => {
    it("should create an adapter with url option", () => {
      const adapter = createPostgresState({
        url: "postgres://postgres:postgres@localhost:5432/chat",
        logger: mockLogger,
      });
      expect(adapter).toBeInstanceOf(PostgresStateAdapter);
    });

    it("should create an adapter with custom keyPrefix", () => {
      const adapter = createPostgresState({
        url: "postgres://postgres:postgres@localhost:5432/chat",
        keyPrefix: "custom-prefix",
        logger: mockLogger,
      });
      expect(adapter).toBeInstanceOf(PostgresStateAdapter);
    });

    it("should throw when no url or env var is available", () => {
      const originalPostgres = process.env.POSTGRES_URL;
      const originalDatabase = process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      try {
        expect(() => createPostgresState({ logger: mockLogger })).toThrow(
          "Postgres url is required"
        );
      } finally {
        if (originalPostgres !== undefined) {
          process.env.POSTGRES_URL = originalPostgres;
        }
        if (originalDatabase !== undefined) {
          process.env.DATABASE_URL = originalDatabase;
        }
      }
    });

    it("should use POSTGRES_URL env var as fallback", () => {
      const original = process.env.POSTGRES_URL;
      process.env.POSTGRES_URL =
        "postgres://postgres:postgres@localhost:5432/chat";

      try {
        const adapter = createPostgresState({ logger: mockLogger });
        expect(adapter).toBeInstanceOf(PostgresStateAdapter);
      } finally {
        if (original !== undefined) {
          process.env.POSTGRES_URL = original;
        } else {
          delete process.env.POSTGRES_URL;
        }
      }
    });

    it("should use DATABASE_URL env var as fallback", () => {
      const originalPostgres = process.env.POSTGRES_URL;
      const originalDatabase = process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
      process.env.DATABASE_URL =
        "postgres://postgres:postgres@localhost:5432/chat";

      try {
        const adapter = createPostgresState({ logger: mockLogger });
        expect(adapter).toBeInstanceOf(PostgresStateAdapter);
      } finally {
        if (originalPostgres !== undefined) {
          process.env.POSTGRES_URL = originalPostgres;
        } else {
          delete process.env.POSTGRES_URL;
        }
        if (originalDatabase !== undefined) {
          process.env.DATABASE_URL = originalDatabase;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });
  });

  describe("ensureConnected", () => {
    it("should throw when calling subscribe before connect", async () => {
      const adapter = createPostgresState({
        url: "postgres://postgres:postgres@localhost:5432/chat",
        logger: mockLogger,
      });
      await expect(adapter.subscribe("thread1")).rejects.toThrow(
        "not connected"
      );
    });

    it("should throw when calling isSubscribed before connect", async () => {
      const adapter = createPostgresState({
        url: "postgres://postgres:postgres@localhost:5432/chat",
        logger: mockLogger,
      });
      await expect(adapter.isSubscribed("thread1")).rejects.toThrow(
        "not connected"
      );
    });

    it("should throw when calling acquireLock before connect", async () => {
      const adapter = createPostgresState({
        url: "postgres://postgres:postgres@localhost:5432/chat",
        logger: mockLogger,
      });
      await expect(adapter.acquireLock("thread1", 5000)).rejects.toThrow(
        "not connected"
      );
    });

    it("should throw when calling get before connect", async () => {
      const adapter = createPostgresState({
        url: "postgres://postgres:postgres@localhost:5432/chat",
        logger: mockLogger,
      });
      await expect(adapter.get("key")).rejects.toThrow("not connected");
    });

    it("should throw when calling set before connect", async () => {
      const adapter = createPostgresState({
        url: "postgres://postgres:postgres@localhost:5432/chat",
        logger: mockLogger,
      });
      await expect(adapter.set("key", "value")).rejects.toThrow(
        "not connected"
      );
    });
  });

  describe.skip("integration tests (require Postgres)", () => {
    it("should connect to Postgres", async () => {
      const adapter = createPostgresState({
        url:
          process.env.POSTGRES_URL ||
          "postgres://postgres:postgres@localhost:5432/chat",
        logger: mockLogger,
      });
      await adapter.connect();
      await adapter.disconnect();
    });
  });
});
