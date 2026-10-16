import { afterEach, describe, expect, it, vi } from "vitest";
import { configurationReadiness, missingVariables, requiredVariables } from "@/lib/config";

afterEach(() => vi.unstubAllEnvs());

describe("setup readiness during staged configuration", () => {
  it("keeps Google connection and manual sync available while the webhook secret is a placeholder", () => {
    for (const key of requiredVariables) vi.stubEnv(key, "mock-configured-value");
    vi.stubEnv("CHATBEDS_WEBHOOK_SECRET", "whsec_REPLACE_ME");
    const missing = missingVariables();
    expect(missing).toEqual(["CHATBEDS_WEBHOOK_SECRET"]);
    expect(configurationReadiness(missing)).toEqual({ googleReady: true, syncReady: true });
  });

  it("allows setup and manual imports before webhooks or cron have been configured", () => {
    expect(configurationReadiness(["CHATBEDS_WEBHOOK_SECRET", "CHATBEDS_WEBHOOK_URL", "CRON_SECRET"]))
      .toEqual({ googleReady: true, syncReady: true });
  });

  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "TOKEN_ENCRYPTION_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SESSION_SECRET", "ADMIN_PASSWORD", "NEXT_PUBLIC_APP_URL"])(
    "prevents Google connection and synchronization without %s", key => {
      expect(configurationReadiness([key])).toEqual({ googleReady: false, syncReady: false });
    },
  );

  it("requires a ChatBeds API key for synchronization without making it a Google OAuth dependency", () => {
    expect(configurationReadiness(["CHATBEDS_API_KEY"]))
      .toEqual({ googleReady: true, syncReady: false });
  });
});
