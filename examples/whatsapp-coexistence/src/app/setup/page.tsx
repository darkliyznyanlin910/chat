"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";

interface SignupResult {
  code: string;
  wabaId: string;
}

interface CallbackResponse {
  success?: boolean;
  error?: string;
  phoneNumbers?: Array<{ id: string; displayNumber: string; verifiedName: string }>;
  expiresInDays?: number;
  message?: string;
  registeredNumbers?: string[];
}

export default function SetupPage() {
  const [appId, setAppId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "signing-up" | "exchanging" | "done" | "error">("idle");
  const [result, setResult] = useState<CallbackResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [origin, setOrigin] = useState("");
  const initRef = useRef(false);
  const wabaIdRef = useRef<string | null>(null);

  // Set origin on mount (avoids hydration mismatch)
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // Fetch app ID from server
  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setAppId(data.appId))
      .catch(() => setErrorMessage("Failed to load app configuration"));
  }, []);

  // Initialize FB SDK once loaded
  useEffect(() => {
    if (!appId || initRef.current) return;

    window.fbAsyncInit = () => {
      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: "v21.0",
      });
      setSdkReady(true);
    };

    // If SDK already loaded (e.g. hot reload), init immediately
    if (window.FB) {
      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: "v21.0",
      });
      setSdkReady(true);
    }

    initRef.current = true;
  }, [appId]);

  // Listen for WA_EMBEDDED_SIGNUP events
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (typeof event.origin === "string" && !event.origin.endsWith("facebook.com")) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "WA_EMBEDDED_SIGNUP") {
          if (data.event === "FINISH" || data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
            // Capture WABA ID from the session event
            if (data.data?.waba_id) {
              wabaIdRef.current = data.data.waba_id;
            }
            console.log("[setup] Signup completed:", data);
          } else if (data.event === "CANCEL") {
            setStatus("idle");
            setErrorMessage("Signup was cancelled");
          }
        }
      } catch {
        // Not JSON, ignore
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const launchSignup = () => {
    if (!window.FB) {
      setErrorMessage("Facebook SDK not loaded yet");
      return;
    }

    setStatus("signing-up");
    setErrorMessage(null);

    window.FB.login(
      async (response: { authResponse?: { code?: string } }) => {
        if (!response.authResponse?.code) {
          setStatus("idle");
          setErrorMessage("Login cancelled or failed — no authorization code received");
          return;
        }

        const code = response.authResponse.code;
        console.log("[setup] Got authorization code");

        // Exchange code via our backend
        setStatus("exchanging");
        try {
          const callbackUrl = new URL("/api/auth/callback", window.location.origin);
          callbackUrl.searchParams.set("code", code);
          if (wabaIdRef.current) {
            callbackUrl.searchParams.set("waba_id", wabaIdRef.current);
          }

          const res = await fetch(callbackUrl.toString());
          const data: CallbackResponse = await res.json();

          if (res.ok && data.success) {
            setStatus("done");
            setResult(data);
          } else {
            setStatus("error");
            setErrorMessage(data.error ?? "Failed to exchange token");
          }
        } catch (err) {
          setStatus("error");
          setErrorMessage(err instanceof Error ? err.message : "Network error");
        }
      },
      {
        config_id: process.env.NEXT_PUBLIC_FB_CONFIG_ID ?? "",
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3",
        },
      }
    );
  };

  return (
    <main>
      <h1>WhatsApp Coexistence Setup</h1>
      <p>
        Connect your WhatsApp Business account to enable bot + human coexistence on the same number.
      </p>

      {appId && (
        <Script
          src="https://connect.facebook.net/en_US/sdk.js"
          strategy="afterInteractive"
          crossOrigin="anonymous"
        />
      )}

      {/* Step 1: Prerequisites */}
      <section style={{ marginTop: "2rem" }}>
        <h2>Prerequisites</h2>
        <ul style={{ lineHeight: "1.8" }}>
          <li>A Meta App with WhatsApp product added (<a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Create one here</a>)</li>
          <li>A WhatsApp Business Account with an active phone number</li>
          <li>Environment variables configured (<code>FACEBOOK_APP_ID</code>, <code>WHATSAPP_APP_SECRET</code>, <code>WHATSAPP_VERIFY_TOKEN</code>)</li>
          <li>A Facebook Login configuration ID set as <code>NEXT_PUBLIC_FB_CONFIG_ID</code></li>
        </ul>
      </section>

      {/* Step 2: Connect */}
      <section style={{ marginTop: "2rem" }}>
        <h2>Connect Your WhatsApp Business Account</h2>

        {!appId ? (
          <div style={{ padding: "16px", background: "#fff3cd", borderRadius: "6px", fontSize: "14px" }}>
            Loading configuration... {errorMessage && <span style={{ color: "#c00" }}>{errorMessage}</span>}
          </div>
        ) : !process.env.NEXT_PUBLIC_FB_CONFIG_ID ? (
          <div style={{ padding: "16px", background: "#fff3cd", borderRadius: "6px", fontSize: "14px" }}>
            <strong>Missing configuration:</strong> Set <code>NEXT_PUBLIC_FB_CONFIG_ID</code> in your environment.
            This is the Facebook Login configuration ID from your Meta App dashboard
            (App Settings &rarr; Use cases &rarr; Customize &rarr; Settings).
          </div>
        ) : status === "idle" ? (
          <div>
            <p style={{ fontSize: "14px", color: "#666", marginBottom: "1rem" }}>
              Click the button below to start the Embedded Signup flow.
              You&apos;ll be asked to log in with Facebook and connect your WhatsApp Business account.
            </p>
            <button
              type="button"
              onClick={launchSignup}
              disabled={!sdkReady}
              style={{
                backgroundColor: sdkReady ? "#1877f2" : "#ccc",
                border: 0,
                borderRadius: "6px",
                color: "#fff",
                cursor: sdkReady ? "pointer" : "not-allowed",
                fontFamily: "Helvetica, Arial, sans-serif",
                fontSize: "16px",
                fontWeight: "bold",
                height: "48px",
                padding: "0 32px",
              }}
            >
              {sdkReady ? "Connect with Facebook" : "Loading Facebook SDK..."}
            </button>
          </div>
        ) : status === "signing-up" ? (
          <div style={{ padding: "16px", background: "#f0f7ff", borderRadius: "6px" }}>
            <p>Waiting for Embedded Signup to complete...</p>
            <p style={{ fontSize: "13px", color: "#666" }}>
              A popup should have opened. Follow the steps to connect your WhatsApp Business account.
            </p>
          </div>
        ) : status === "exchanging" ? (
          <div style={{ padding: "16px", background: "#f0f7ff", borderRadius: "6px" }}>
            <p>Exchanging authorization code for access token...</p>
          </div>
        ) : status === "done" && result ? (
          <div style={{ padding: "16px", background: "#d4edda", borderRadius: "6px" }}>
            <h3 style={{ margin: "0 0 12px", color: "#155724" }}>Connected!</h3>
            <p>{result.message}</p>

            {result.phoneNumbers && result.phoneNumbers.length > 0 && (
              <div style={{ marginTop: "12px" }}>
                <strong>Phone numbers:</strong>
                <ul>
                  {result.phoneNumbers.map((p) => (
                    <li key={p.id}>
                      {p.displayNumber} ({p.verifiedName}) — ID: <code>{p.id}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.expiresInDays != null && result.expiresInDays > 0 && (
              <p style={{ fontSize: "13px", color: "#666" }}>
                Token expires in ~{result.expiresInDays} days. Set up token refresh to avoid interruptions.
              </p>
            )}

            <div style={{ marginTop: "16px" }}>
              <a href="/" style={{ color: "#155724" }}>&larr; Back to home</a>
              {" | "}
              <button
                type="button"
                onClick={() => { setStatus("idle"); setResult(null); }}
                style={{ background: "none", border: "none", color: "#155724", cursor: "pointer", textDecoration: "underline", fontSize: "inherit" }}
              >
                Connect another account
              </button>
            </div>
          </div>
        ) : status === "error" ? (
          <div style={{ padding: "16px", background: "#f8d7da", borderRadius: "6px" }}>
            <h3 style={{ margin: "0 0 8px", color: "#721c24" }}>Setup Failed</h3>
            <p style={{ color: "#721c24" }}>{errorMessage}</p>
            <button
              type="button"
              onClick={() => { setStatus("idle"); setErrorMessage(null); }}
              style={{ marginTop: "8px", padding: "8px 16px", border: "1px solid #721c24", borderRadius: "4px", background: "transparent", color: "#721c24", cursor: "pointer" }}
            >
              Try Again
            </button>
          </div>
        ) : null}

        {errorMessage && status === "idle" && (
          <p style={{ color: "#c00", marginTop: "8px", fontSize: "14px" }}>{errorMessage}</p>
        )}
      </section>

      {/* Step 3: Next steps */}
      <section style={{ marginTop: "2rem" }}>
        <h2>After Connecting</h2>
        <ol style={{ lineHeight: "2" }}>
          <li>
            Configure your webhook URL in the Meta App Dashboard:
            <br />
            <code style={{ fontSize: "13px" }}>{origin}/api/webhooks/whatsapp</code>
          </li>
          <li>
            Use the verify token from your <code>WHATSAPP_VERIFY_TOKEN</code> env var
          </li>
          <li>
            Subscribe to: <strong>messages</strong>, <strong>smb_message_echoes</strong>, <strong>smb_app_state_sync</strong>
          </li>
          <li>
            Set the partner webhook for history sync:
            <br />
            <code style={{ fontSize: "13px" }}>{origin}/api/partner-webhook</code>
          </li>
        </ol>
      </section>

      <div style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #eee" }}>
        <a href="/">&larr; Back to home</a>
      </div>
    </main>
  );
}

// TypeScript declarations for Facebook SDK
declare global {
  interface Window {
    FB: {
      init: (params: {
        appId: string;
        autoLogAppEvents: boolean;
        xfbml: boolean;
        version: string;
      }) => void;
      login: (
        callback: (response: { authResponse?: { code?: string } }) => void,
        options: {
          config_id: string;
          response_type: string;
          override_default_response_type: boolean;
          extras: Record<string, unknown>;
        }
      ) => void;
    };
    fbAsyncInit: () => void;
  }
}
