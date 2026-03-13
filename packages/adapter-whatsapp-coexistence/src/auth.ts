/**
 * Authentication and token management utilities for WhatsApp Cloud API.
 *
 * Handles the OAuth flows needed for coexistence mode onboarding:
 * - Embedded Signup code exchange (OAuth code → access token)
 * - Short-lived → long-lived token extension
 * - Token validation/debugging
 * - Phone number ID discovery from a WABA
 * - Verify token generation for webhook setup
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/
 */

import { randomBytes } from "node:crypto";

/** Default Graph API version */
const DEFAULT_API_VERSION = "v21.0";

/** Base URL for Meta Graph API */
const GRAPH_API_BASE = "https://graph.facebook.com";

// =============================================================================
// Types
// =============================================================================

/**
 * Credentials needed for OAuth operations.
 * Typically sourced from environment variables.
 */
export interface AppCredentials {
  /** Facebook App ID */
  appId: string;
  /** Facebook App Secret (from App Dashboard → Settings → Basic) */
  appSecret: string;
  /** Graph API version (default: "v21.0") */
  apiVersion?: string;
}

/**
 * Result of exchanging an OAuth code for an access token.
 */
export interface TokenExchangeResult {
  /** The access token */
  accessToken: string;
  /** Token type (usually "bearer") */
  tokenType: string;
  /** Expiry in seconds (0 = never expires for long-lived tokens) */
  expiresIn: number;
}

/**
 * Result of debugging/validating an access token.
 */
export interface TokenDebugResult {
  /** Whether the token is currently valid */
  isValid: boolean;
  /** The app ID the token belongs to */
  appId: string;
  /** Token type */
  type: string;
  /** Expiry timestamp (0 = never) */
  expiresAt: number;
  /** Scopes granted to this token */
  scopes: string[];
  /** User ID or System User ID */
  userId: string;
  /** Error info if token is invalid */
  error?: {
    code: number;
    message: string;
    subcode: number;
  };
}

/**
 * A WhatsApp Business phone number registered to a WABA.
 */
export interface PhoneNumberInfo {
  /** Phone number ID (use this for API calls) */
  id: string;
  /** Display phone number (e.g., "+1 555 123 4567") */
  displayPhoneNumber: string;
  /** Verified name for this phone number */
  verifiedName: string;
  /** Quality rating */
  qualityRating: string;
  /** Phone number status */
  status: string;
}

/**
 * Result of fetching WABA info including phone numbers.
 */
export interface WABAInfo {
  /** WhatsApp Business Account ID */
  id: string;
  /** WABA name */
  name: string;
  /** Registered phone numbers */
  phoneNumbers: PhoneNumberInfo[];
}

// =============================================================================
// Token Exchange
// =============================================================================

/**
 * Exchange an OAuth authorization code for an access token.
 *
 * Used during **Embedded Signup** onboarding for coexistence mode.
 * The signup flow returns a `code` parameter which you exchange here
 * for a long-lived access token.
 *
 * @param code - The authorization code from Embedded Signup callback
 * @param credentials - Your Facebook App ID and App Secret
 * @returns The access token and metadata
 *
 * @example
 * ```typescript
 * // In your Embedded Signup callback handler:
 * const { accessToken } = await exchangeCodeForToken(code, {
 *   appId: process.env.FACEBOOK_APP_ID!,
 *   appSecret: process.env.WHATSAPP_APP_SECRET!,
 * });
 * // Store accessToken securely — use it as WHATSAPP_ACCESS_TOKEN
 * ```
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/
 */
export async function exchangeCodeForToken(
  code: string,
  credentials: AppCredentials
): Promise<TokenExchangeResult> {
  const apiVersion = credentials.apiVersion ?? DEFAULT_API_VERSION;
  const url = new URL(`${GRAPH_API_BASE}/${apiVersion}/oauth/access_token`);
  url.searchParams.set("client_id", credentials.appId);
  url.searchParams.set("client_secret", credentials.appSecret);
  url.searchParams.set("code", code);

  const response = await fetch(url.toString());
  const data = await handleGraphApiResponse<{
    access_token: string;
    token_type: string;
    expires_in?: number;
  }>(response, "exchangeCodeForToken");

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in ?? 0,
  };
}

/**
 * Exchange a short-lived access token for a long-lived one.
 *
 * Short-lived tokens (from Embedded Signup or Login) expire in ~1 hour.
 * Long-lived tokens last ~60 days. System User tokens never expire.
 *
 * @param shortLivedToken - The short-lived access token to extend
 * @param credentials - Your Facebook App ID and App Secret
 * @returns A new long-lived access token
 *
 * @example
 * ```typescript
 * const { accessToken: longLivedToken } = await extendToken(
 *   shortLivedToken,
 *   {
 *     appId: process.env.FACEBOOK_APP_ID!,
 *     appSecret: process.env.WHATSAPP_APP_SECRET!,
 *   }
 * );
 * ```
 *
 * @see https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
 */
export async function extendToken(
  shortLivedToken: string,
  credentials: AppCredentials
): Promise<TokenExchangeResult> {
  const apiVersion = credentials.apiVersion ?? DEFAULT_API_VERSION;
  const url = new URL(`${GRAPH_API_BASE}/${apiVersion}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", credentials.appId);
  url.searchParams.set("client_secret", credentials.appSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const response = await fetch(url.toString());
  const data = await handleGraphApiResponse<{
    access_token: string;
    token_type: string;
    expires_in?: number;
  }>(response, "extendToken");

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in ?? 0,
  };
}

// =============================================================================
// Token Validation
// =============================================================================

/**
 * Debug/validate an access token.
 *
 * Checks whether a token is valid, what scopes it has, and when it expires.
 * Useful for health checks and token rotation monitoring.
 *
 * @param accessToken - The access token to validate
 * @param credentials - Your Facebook App ID and App Secret
 * @returns Token debug information
 *
 * @example
 * ```typescript
 * const debug = await debugToken(
 *   process.env.WHATSAPP_ACCESS_TOKEN!,
 *   {
 *     appId: process.env.FACEBOOK_APP_ID!,
 *     appSecret: process.env.WHATSAPP_APP_SECRET!,
 *   }
 * );
 *
 * if (!debug.isValid) {
 *   console.error("Token invalid:", debug.error?.message);
 * }
 *
 * if (debug.expiresAt > 0) {
 *   const expiresIn = debug.expiresAt * 1000 - Date.now();
 *   console.log(`Token expires in ${Math.round(expiresIn / 86400000)} days`);
 * }
 * ```
 *
 * @see https://developers.facebook.com/docs/facebook-login/guides/access-tokens/debugging/
 */
export async function debugToken(
  accessToken: string,
  credentials: AppCredentials
): Promise<TokenDebugResult> {
  const apiVersion = credentials.apiVersion ?? DEFAULT_API_VERSION;
  const appToken = `${credentials.appId}|${credentials.appSecret}`;
  const url = new URL(`${GRAPH_API_BASE}/${apiVersion}/debug_token`);
  url.searchParams.set("input_token", accessToken);
  url.searchParams.set("access_token", appToken);

  const response = await fetch(url.toString());
  const data = await handleGraphApiResponse<{
    data: {
      app_id: string;
      type: string;
      is_valid: boolean;
      expires_at: number;
      scopes: string[];
      user_id: string;
      error?: {
        code: number;
        message: string;
        subcode: number;
      };
    };
  }>(response, "debugToken");

  return {
    isValid: data.data.is_valid,
    appId: data.data.app_id,
    type: data.data.type,
    expiresAt: data.data.expires_at,
    scopes: data.data.scopes,
    userId: data.data.user_id,
    error: data.data.error,
  };
}

// =============================================================================
// WABA & Phone Number Discovery
// =============================================================================

/**
 * Fetch WhatsApp Business Account info and registered phone numbers.
 *
 * After Embedded Signup, you receive a WABA ID. Use this to discover
 * the phone number IDs you need for the adapter config.
 *
 * @param wabaId - WhatsApp Business Account ID
 * @param accessToken - Access token with `whatsapp_business_management` scope
 * @param apiVersion - Graph API version (default: "v21.0")
 * @returns WABA info including phone numbers
 *
 * @example
 * ```typescript
 * const waba = await fetchWABAInfo("123456789", accessToken);
 * const phoneNumberId = waba.phoneNumbers[0].id;
 * // Use phoneNumberId as WHATSAPP_PHONE_NUMBER_ID
 * ```
 *
 * @see https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers
 */
export async function fetchWABAInfo(
  wabaId: string,
  accessToken: string,
  apiVersion = DEFAULT_API_VERSION
): Promise<WABAInfo> {
  // Fetch WABA details and phone numbers in parallel
  const [wabaResponse, phonesResponse] = await Promise.all([
    fetch(
      `${GRAPH_API_BASE}/${apiVersion}/${wabaId}?fields=id,name`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ),
    fetch(
      `${GRAPH_API_BASE}/${apiVersion}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ),
  ]);

  const wabaData = await handleGraphApiResponse<{
    id: string;
    name: string;
  }>(wabaResponse, "fetchWABAInfo (waba)");

  const phonesData = await handleGraphApiResponse<{
    data: Array<{
      id: string;
      display_phone_number: string;
      verified_name: string;
      quality_rating: string;
      status: string;
    }>;
  }>(phonesResponse, "fetchWABAInfo (phones)");

  return {
    id: wabaData.id,
    name: wabaData.name,
    phoneNumbers: phonesData.data.map((p) => ({
      id: p.id,
      displayPhoneNumber: p.display_phone_number,
      verifiedName: p.verified_name,
      qualityRating: p.quality_rating,
      status: p.status,
    })),
  };
}

/**
 * Subscribe a WABA to webhook events.
 *
 * Must be called after obtaining an access token to enable webhook
 * delivery for the WhatsApp Business Account.
 *
 * @param wabaId - WhatsApp Business Account ID
 * @param accessToken - Access token with `whatsapp_business_management` scope
 * @param apiVersion - Graph API version (default: "v21.0")
 *
 * @example
 * ```typescript
 * await subscribeToWebhooks("123456789", accessToken);
 * ```
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
 */
export async function subscribeToWebhooks(
  wabaId: string,
  accessToken: string,
  apiVersion = DEFAULT_API_VERSION
): Promise<void> {
  const response = await fetch(
    `${GRAPH_API_BASE}/${apiVersion}/${wabaId}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  await handleGraphApiResponse(response, "subscribeToWebhooks");
}

// =============================================================================
// Verify Token Generation
// =============================================================================

/**
 * Generate a cryptographically random verify token for webhook setup.
 *
 * The verify token is a string you define and configure in both:
 * 1. Your Meta App Dashboard (Webhooks → Configure)
 * 2. Your adapter config / `WHATSAPP_VERIFY_TOKEN` env var
 *
 * Meta sends this token in the GET verification challenge to confirm
 * you own the webhook endpoint.
 *
 * @param length - Number of random bytes (default: 32, produces 64-char hex string)
 * @returns A random hex string suitable as a verify token
 *
 * @example
 * ```typescript
 * const verifyToken = generateVerifyToken();
 * console.log(verifyToken);
 * // => "a1b2c3d4e5f6..." (64 hex chars)
 * // Set this as WHATSAPP_VERIFY_TOKEN and in your Meta App Dashboard
 * ```
 */
export function generateVerifyToken(length = 32): string {
  return randomBytes(length).toString("hex");
}

// =============================================================================
// Credential Helpers
// =============================================================================

/**
 * Load app credentials from environment variables.
 *
 * Reads `FACEBOOK_APP_ID` and `WHATSAPP_APP_SECRET` from the environment.
 * Throws if either is missing.
 *
 * @returns App credentials for use with auth functions
 *
 * @example
 * ```typescript
 * const credentials = loadCredentialsFromEnv();
 * const { accessToken } = await exchangeCodeForToken(code, credentials);
 * ```
 */
export function loadCredentialsFromEnv(): AppCredentials {
  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) {
    throw new Error(
      "FACEBOOK_APP_ID environment variable is required. " +
        "Find it in your Meta App Dashboard → Settings → Basic."
    );
  }

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    throw new Error(
      "WHATSAPP_APP_SECRET environment variable is required. " +
        "Find it in your Meta App Dashboard → Settings → Basic."
    );
  }

  return { appId, appSecret };
}

/**
 * Validate that all required WhatsApp environment variables are set.
 *
 * Checks for:
 * - `WHATSAPP_ACCESS_TOKEN`
 * - `WHATSAPP_APP_SECRET`
 * - `WHATSAPP_PHONE_NUMBER_ID`
 * - `WHATSAPP_VERIFY_TOKEN`
 *
 * @returns Object with all required env values
 * @throws Error listing all missing variables
 *
 * @example
 * ```typescript
 * const env = validateEnv();
 * const adapter = createWhatsAppCoexistenceAdapter({
 *   accessToken: env.accessToken,
 *   appSecret: env.appSecret,
 *   phoneNumberId: env.phoneNumberId,
 *   verifyToken: env.verifyToken,
 * });
 * ```
 */
export function validateEnv(): {
  accessToken: string;
  appSecret: string;
  phoneNumberId: string;
  verifyToken: string;
} {
  const missing: string[] = [];

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) missing.push("WHATSAPP_ACCESS_TOKEN");

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) missing.push("WHATSAPP_APP_SECRET");

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "See https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
    );
  }

  return {
    accessToken: accessToken!,
    appSecret: appSecret!,
    phoneNumberId: phoneNumberId!,
    verifyToken: verifyToken!,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Handle a Graph API response, throwing a descriptive error on failure.
 */
async function handleGraphApiResponse<T>(
  response: Response,
  operation: string
): Promise<T> {
  if (!response.ok) {
    let errorDetail: string;
    try {
      const errorBody = await response.json() as {
        error?: { message?: string; type?: string; code?: number };
      };
      errorDetail = errorBody.error?.message
        ? `${errorBody.error.type ?? "Error"}: ${errorBody.error.message} (code ${errorBody.error.code})`
        : `HTTP ${response.status}`;
    } catch {
      errorDetail = `HTTP ${response.status} ${response.statusText}`;
    }
    throw new Error(`${operation} failed: ${errorDetail}`);
  }

  return response.json() as Promise<T>;
}
