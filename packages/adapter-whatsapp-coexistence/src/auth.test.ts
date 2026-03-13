import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  debugToken,
  exchangeCodeForToken,
  extendToken,
  fetchWABAInfo,
  generateVerifyToken,
  loadCredentialsFromEnv,
  subscribeToWebhooks,
  validateEnv,
} from "./auth";

// =============================================================================
// Helpers
// =============================================================================

const TEST_CREDENTIALS = {
  appId: "test-app-id",
  appSecret: "test-app-secret",
};

function mockFetchResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchError(message: string, code = 100): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "OAuthException", code },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

// =============================================================================
// exchangeCodeForToken
// =============================================================================

describe("exchangeCodeForToken", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should exchange a code for an access token", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        access_token: "long-lived-token-123",
        token_type: "bearer",
        expires_in: 0,
      })
    );

    const result = await exchangeCodeForToken("auth-code-xyz", TEST_CREDENTIALS);

    expect(result.accessToken).toBe("long-lived-token-123");
    expect(result.tokenType).toBe("bearer");
    expect(result.expiresIn).toBe(0);

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toContain("/oauth/access_token");
    expect(url.searchParams.get("client_id")).toBe("test-app-id");
    expect(url.searchParams.get("client_secret")).toBe("test-app-secret");
    expect(url.searchParams.get("code")).toBe("auth-code-xyz");
  });

  it("should throw on API error", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchError("Invalid verification code", 100)
    );

    await expect(
      exchangeCodeForToken("bad-code", TEST_CREDENTIALS)
    ).rejects.toThrow(/exchangeCodeForToken failed/);
  });

  it("should use custom API version", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        access_token: "token",
        token_type: "bearer",
      })
    );

    await exchangeCodeForToken("code", {
      ...TEST_CREDENTIALS,
      apiVersion: "v22.0",
    });

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toContain("/v22.0/");
  });
});

// =============================================================================
// extendToken
// =============================================================================

describe("extendToken", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should exchange short-lived token for long-lived token", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        access_token: "long-lived-token",
        token_type: "bearer",
        expires_in: 5184000, // 60 days
      })
    );

    const result = await extendToken("short-lived-token", TEST_CREDENTIALS);

    expect(result.accessToken).toBe("long-lived-token");
    expect(result.expiresIn).toBe(5184000);

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(url.searchParams.get("fb_exchange_token")).toBe("short-lived-token");
  });

  it("should throw on expired token", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchError("Error validating access token", 190)
    );

    await expect(
      extendToken("expired-token", TEST_CREDENTIALS)
    ).rejects.toThrow(/extendToken failed/);
  });
});

// =============================================================================
// debugToken
// =============================================================================

describe("debugToken", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should return valid token info", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        data: {
          app_id: "test-app-id",
          type: "USER",
          is_valid: true,
          expires_at: 0,
          scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
          user_id: "system-user-123",
        },
      })
    );

    const result = await debugToken("some-token", TEST_CREDENTIALS);

    expect(result.isValid).toBe(true);
    expect(result.appId).toBe("test-app-id");
    expect(result.scopes).toContain("whatsapp_business_messaging");
    expect(result.userId).toBe("system-user-123");
    expect(result.expiresAt).toBe(0);
    expect(result.error).toBeUndefined();

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get("input_token")).toBe("some-token");
    expect(url.searchParams.get("access_token")).toBe(
      "test-app-id|test-app-secret"
    );
  });

  it("should return invalid token with error details", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        data: {
          app_id: "test-app-id",
          type: "USER",
          is_valid: false,
          expires_at: 1700000000,
          scopes: [],
          user_id: "",
          error: {
            code: 190,
            message: "Error validating access token",
            subcode: 463,
          },
        },
      })
    );

    const result = await debugToken("bad-token", TEST_CREDENTIALS);

    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe(190);
    expect(result.error?.message).toContain("validating access token");
  });
});

// =============================================================================
// fetchWABAInfo
// =============================================================================

describe("fetchWABAInfo", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should fetch WABA info and phone numbers", async () => {
    // Two parallel requests: WABA details + phone numbers
    fetchSpy
      .mockResolvedValueOnce(
        mockFetchResponse({
          id: "waba-123",
          name: "My Business",
        })
      )
      .mockResolvedValueOnce(
        mockFetchResponse({
          data: [
            {
              id: "phone-456",
              display_phone_number: "+1 555 123 4567",
              verified_name: "My Business",
              quality_rating: "GREEN",
              status: "CONNECTED",
            },
            {
              id: "phone-789",
              display_phone_number: "+44 20 1234 5678",
              verified_name: "My Business UK",
              quality_rating: "GREEN",
              status: "CONNECTED",
            },
          ],
        })
      );

    const result = await fetchWABAInfo("waba-123", "access-token");

    expect(result.id).toBe("waba-123");
    expect(result.name).toBe("My Business");
    expect(result.phoneNumbers).toHaveLength(2);
    expect(result.phoneNumbers[0].id).toBe("phone-456");
    expect(result.phoneNumbers[0].displayPhoneNumber).toBe("+1 555 123 4567");
    expect(result.phoneNumbers[1].id).toBe("phone-789");

    // Verify both requests were made with auth header
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      expect(call[1]?.headers?.Authorization).toBe("Bearer access-token");
    }
  });

  it("should throw on API error", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchError("Invalid WABA ID", 100))
      .mockResolvedValueOnce(mockFetchResponse({ data: [] }));

    await expect(
      fetchWABAInfo("bad-waba", "access-token")
    ).rejects.toThrow(/fetchWABAInfo/);
  });
});

// =============================================================================
// subscribeToWebhooks
// =============================================================================

describe("subscribeToWebhooks", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should POST to subscribe endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ success: true })
    );

    await subscribeToWebhooks("waba-123", "access-token");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/waba-123/subscribed_apps");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer access-token");
  });

  it("should throw on failure", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchError("Permission denied", 200)
    );

    await expect(
      subscribeToWebhooks("waba-123", "bad-token")
    ).rejects.toThrow(/subscribeToWebhooks failed/);
  });
});

// =============================================================================
// generateVerifyToken
// =============================================================================

describe("generateVerifyToken", () => {
  it("should generate a 64-char hex string by default", () => {
    const token = generateVerifyToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should generate different tokens each call", () => {
    const token1 = generateVerifyToken();
    const token2 = generateVerifyToken();
    expect(token1).not.toBe(token2);
  });

  it("should respect custom length", () => {
    const token = generateVerifyToken(16);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

// =============================================================================
// loadCredentialsFromEnv
// =============================================================================

describe("loadCredentialsFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of ["FACEBOOK_APP_ID", "WHATSAPP_APP_SECRET"]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("should load credentials from env", () => {
    process.env.FACEBOOK_APP_ID = "env-app-id";
    process.env.WHATSAPP_APP_SECRET = "env-app-secret";

    const creds = loadCredentialsFromEnv();
    expect(creds.appId).toBe("env-app-id");
    expect(creds.appSecret).toBe("env-app-secret");
  });

  it("should throw when FACEBOOK_APP_ID is missing", () => {
    delete process.env.FACEBOOK_APP_ID;
    process.env.WHATSAPP_APP_SECRET = "secret";

    expect(() => loadCredentialsFromEnv()).toThrow(/FACEBOOK_APP_ID/);
  });

  it("should throw when WHATSAPP_APP_SECRET is missing", () => {
    process.env.FACEBOOK_APP_ID = "app-id";
    delete process.env.WHATSAPP_APP_SECRET;

    expect(() => loadCredentialsFromEnv()).toThrow(/WHATSAPP_APP_SECRET/);
  });
});

// =============================================================================
// validateEnv
// =============================================================================

describe("validateEnv", () => {
  const originalEnv = { ...process.env };
  const requiredKeys = [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_VERIFY_TOKEN",
  ];

  afterEach(() => {
    for (const key of requiredKeys) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("should return all env values when set", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_APP_SECRET = "secret";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-id";
    process.env.WHATSAPP_VERIFY_TOKEN = "verify";

    const env = validateEnv();
    expect(env.accessToken).toBe("token");
    expect(env.appSecret).toBe("secret");
    expect(env.phoneNumberId).toBe("phone-id");
    expect(env.verifyToken).toBe("verify");
  });

  it("should throw listing all missing vars", () => {
    for (const key of requiredKeys) {
      delete process.env[key];
    }

    expect(() => validateEnv()).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    expect(() => validateEnv()).toThrow(/WHATSAPP_VERIFY_TOKEN/);
  });

  it("should throw listing only the missing vars", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_APP_SECRET = "secret";
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_VERIFY_TOKEN;

    try {
      validateEnv();
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("WHATSAPP_PHONE_NUMBER_ID");
      expect(msg).toContain("WHATSAPP_VERIFY_TOKEN");
      expect(msg).not.toContain("WHATSAPP_ACCESS_TOKEN");
      expect(msg).not.toContain("WHATSAPP_APP_SECRET");
    }
  });
});
