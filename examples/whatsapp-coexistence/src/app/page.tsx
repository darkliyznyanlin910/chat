import { validateEnv, generateVerifyToken } from "@chat-adapter/whatsapp-coexistence";

function EnvStatus() {
  const required = [
    "FACEBOOK_APP_ID",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_VERIFY_TOKEN",
  ];

  const status = required.map((key) => ({
    key,
    set: !!process.env[key],
  }));

  const allSet = status.every((s) => s.set);

  let validationError: string | null = null;
  if (allSet) {
    try {
      validateEnv();
    } catch (err) {
      validationError = err instanceof Error ? err.message : "Validation failed";
    }
  }

  return (
    <div>
      <h2>Environment Variables</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Variable</th>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {status.map(({ key, set }) => (
            <tr key={key}>
              <td style={{ padding: "8px", borderBottom: "1px solid #eee", fontFamily: "monospace", fontSize: "14px" }}>{key}</td>
              <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>
                {set ? "\u2705 Set" : "\u274c Missing"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {validationError && (
        <p style={{ color: "red", marginTop: "1rem" }}>Validation error: {validationError}</p>
      )}
      {allSet && !validationError && (
        <p style={{ color: "green", marginTop: "1rem" }}>All environment variables are configured.</p>
      )}
    </div>
  );
}

export default function SetupPage() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://your-app.vercel.app";
  const suggestedToken = generateVerifyToken();

  return (
    <main>
      <h1>WhatsApp Coexistence Demo</h1>
      <p>
        This app demonstrates WhatsApp coexistence mode with the Vercel Chat SDK.
        Both the WhatsApp Business App and Cloud API can operate on the same phone number simultaneously.
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
            [`GET/POST ${appUrl}/api/webhooks/whatsapp`, "WhatsApp webhook (verification + messages)"],
            [`POST ${appUrl}/api/partner-webhook`, "Partner webhook (history sync during onboarding)"],
            [`GET ${appUrl}/api/auth/callback`, "Embedded Signup OAuth callback"],
            [`GET ${appUrl}/api/health`, "Health check (token validity, adapter status)"],
          ].map(([endpoint, purpose]) => (
            <tr key={endpoint}>
              <td style={{ padding: "8px", borderBottom: "1px solid #eee", fontFamily: "monospace", fontSize: "13px" }}>{endpoint}</td>
              <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>{purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Setup Steps</h2>
      <ol style={{ lineHeight: "2" }}>
        <li>
          Create a Meta App at{" "}
          <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">
            developers.facebook.com
          </a>
        </li>
        <li>Add the WhatsApp product to your app</li>
        <li>
          Copy your <strong>App ID</strong> and <strong>App Secret</strong> from Settings &rarr; Basic
        </li>
        <li>
          Set up a System User or complete Embedded Signup to get an <strong>Access Token</strong>
        </li>
        <li>
          Use this as your <strong>Verify Token</strong>:{" "}
          <code style={{ background: "#f4f4f4", padding: "2px 6px", borderRadius: "3px" }}>
            {suggestedToken}
          </code>
        </li>
        <li>
          Configure webhooks in Meta App Dashboard:
          <ul>
            <li>Callback URL: <code>{appUrl}/api/webhooks/whatsapp</code></li>
            <li>Subscribe to: <strong>messages</strong>, <strong>smb_message_echoes</strong>, <strong>smb_app_state_sync</strong></li>
          </ul>
        </li>
        <li>
          For coexistence onboarding, set partner webhook to: <code>{appUrl}/api/partner-webhook</code>
        </li>
        <li>Set all environment variables and restart</li>
      </ol>

      <h2>How It Works</h2>
      <ul style={{ lineHeight: "1.8" }}>
        <li>Customer messages arrive at the bot via Cloud API webhooks</li>
        <li>If a human replies from the Business App, the bot detects it via <code>smb_message_echoes</code></li>
        <li>The bot pauses for 30 minutes on that thread, letting the human handle it</li>
        <li>After 30 minutes of human inactivity, the bot resumes</li>
        <li>The customer sees a single conversation — no switching between numbers</li>
      </ul>
    </main>
  );
}
