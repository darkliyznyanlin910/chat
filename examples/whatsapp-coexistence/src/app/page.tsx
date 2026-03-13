import { generateVerifyToken } from "@chat-adapter/whatsapp-coexistence";

function EnvStatus() {
  const mode = process.env.WHATSAPP_MODE ?? "single";

  const shared = [
    { key: "FACEBOOK_APP_ID", required: true },
    { key: "WHATSAPP_APP_SECRET", required: true },
    { key: "WHATSAPP_MODE", required: false, note: `Current: "${mode}"` },
  ];

  const singleOnly = [
    { key: "WHATSAPP_ACCESS_TOKEN", required: mode === "single" },
    { key: "WHATSAPP_PHONE_NUMBER_ID", required: mode === "single" },
    { key: "WHATSAPP_VERIFY_TOKEN", required: mode === "single" },
  ];

  const allVars = mode === "single" ? [...shared, ...singleOnly] : shared;

  return (
    <div>
      <h2>Environment Variables</h2>
      <p style={{ color: "#666", fontSize: "14px" }}>
        Mode: <strong>{mode === "multi" ? "Multi-number" : "Single-number"}</strong>
        {" "}(set <code>WHATSAPP_MODE=multi</code> to enable multi-number)
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Variable</th>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Status</th>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Note</th>
          </tr>
        </thead>
        <tbody>
          {allVars.map(({ key, required, note }) => {
            const isSet = !!process.env[key];
            return (
              <tr key={key}>
                <td style={{ padding: "8px", borderBottom: "1px solid #eee", fontFamily: "monospace", fontSize: "14px" }}>{key}</td>
                <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>
                  {isSet ? "\u2705 Set" : required ? "\u274c Missing" : "\u2796 Not set"}
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid #eee", fontSize: "13px", color: "#666" }}>
                  {note ?? (required ? "Required" : "Optional")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {mode === "multi" && (
        <p style={{ marginTop: "1rem", padding: "12px", background: "#f0f7ff", borderRadius: "6px", fontSize: "14px" }}>
          In <strong>multi-number mode</strong>, phone-number-specific credentials
          (access token, phone number ID, verify token) are stored in the state adapter
          via the credential store. Use the Embedded Signup flow at{" "}
          <code>/api/auth/callback</code> to register new numbers, or add them via the API.
        </p>
      )}
    </div>
  );
}

export default function SetupPage() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://your-app.vercel.app";
  const suggestedToken = generateVerifyToken();
  const mode = process.env.WHATSAPP_MODE ?? "single";

  return (
    <main>
      <h1>WhatsApp Coexistence Demo</h1>
      <p>
        Bot + human on the same WhatsApp number using the Vercel Chat SDK.
      </p>

      <EnvStatus />

      <h2>Endpoints</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Endpoint</th>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Purpose</th>
          </tr>
        </thead>
        <tbody>
          {[
            [`GET/POST /api/webhooks/whatsapp`, "WhatsApp webhook (verification + messages)"],
            [`POST /api/partner-webhook`, "History sync during coexistence onboarding"],
            [`GET /api/auth/callback`, "Embedded Signup OAuth callback (stores credentials)"],
            [`GET /api/health`, "Health check (token validity per number)"],
          ].map(([endpoint, purpose]) => (
            <tr key={endpoint}>
              <td style={{ padding: "8px", borderBottom: "1px solid #eee", fontFamily: "monospace", fontSize: "13px" }}>{endpoint}</td>
              <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>{purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Setup</h2>
      <ol style={{ lineHeight: "2" }}>
        <li>
          Create a Meta App at{" "}
          <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">
            developers.facebook.com
          </a>
        </li>
        <li>Set <code>FACEBOOK_APP_ID</code> and <code>WHATSAPP_APP_SECRET</code> from Settings &rarr; Basic</li>
        {mode === "single" ? (
          <>
            <li>Get an access token (System User or Embedded Signup) and set <code>WHATSAPP_ACCESS_TOKEN</code></li>
            <li>Set <code>WHATSAPP_PHONE_NUMBER_ID</code> from WABA dashboard</li>
            <li>
              Generate a verify token:{" "}
              <code style={{ background: "#f4f4f4", padding: "2px 6px", borderRadius: "3px" }}>{suggestedToken}</code>
              {" "}and set <code>WHATSAPP_VERIFY_TOKEN</code>
            </li>
          </>
        ) : (
          <li>
            Complete the Embedded Signup flow — the OAuth callback at{" "}
            <code>/api/auth/callback</code> will store credentials automatically
          </li>
        )}
        <li>
          Configure webhooks in Meta App Dashboard:
          <ul>
            <li>Callback URL: <code>{appUrl}/api/webhooks/whatsapp</code></li>
            <li>Subscribe to: <strong>messages</strong>, <strong>smb_message_echoes</strong>, <strong>smb_app_state_sync</strong></li>
          </ul>
        </li>
        <li>
          For history sync, set partner webhook to: <code>{appUrl}/api/partner-webhook</code>
        </li>
      </ol>

      <h2>How It Works</h2>
      <ul style={{ lineHeight: "1.8" }}>
        <li>Customer messages arrive at the bot via Cloud API webhooks</li>
        <li>If a human replies from the Business App, the bot detects it via <code>smb_message_echoes</code></li>
        <li>The bot pauses for 30 minutes on that thread, letting the human handle it</li>
        <li>After 30 minutes of inactivity, the bot resumes</li>
        {mode === "multi" && (
          <>
            <li>Each phone number gets its own adapter instance with separate credentials</li>
            <li>Webhooks are routed by <code>phone_number_id</code> in the payload metadata</li>
            <li>New numbers can be added via the Embedded Signup flow at any time</li>
          </>
        )}
      </ul>

      <h2>Credential Storage</h2>
      <div style={{ padding: "16px", background: "#f8f8f8", borderRadius: "6px", fontSize: "14px", lineHeight: "1.6" }}>
        {mode === "single" ? (
          <p>
            <strong>Single-number mode</strong>: Credentials are read from environment variables.
            Switch to multi-number mode by setting <code>WHATSAPP_MODE=multi</code>.
          </p>
        ) : (
          <>
            <p>
              <strong>Multi-number mode</strong>: Per-number credentials are stored in the state adapter
              (<code>StateCredentialStore</code>). This works with any Chat SDK state backend:
            </p>
            <ul>
              <li><code>MemoryState</code> — development (not persisted across restarts)</li>
              <li><code>RedisState</code> / <code>IoRedisState</code> — production</li>
              <li><code>PostgresState</code> — production with SQL</li>
            </ul>
            <p>
              Swap the state adapter in <code>src/lib/bot.ts</code> to use your preferred backend.
              The credential store interface is the same regardless of backend.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
