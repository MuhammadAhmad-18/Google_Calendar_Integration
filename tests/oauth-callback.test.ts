import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), verifyIdToken: vi.fn(), rpc: vi.fn(), cookies: vi.fn(), getCredentials: vi.fn(), saveCredentials: vi.fn(), logSync: vi.fn(), updateIntegration: vi.fn(), after: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/auth/session", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/auth/session")>(), requireAdmin: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: () => ({ rpc: mocks.rpc }), checked: (result: { data: unknown }) => result.data }));
vi.mock("@/lib/db/store", () => ({
  getCredentials: mocks.getCredentials, logSync: mocks.logSync, saveCredentials: mocks.saveCredentials, updateIntegration: mocks.updateIntegration,
  withIntegrationLock: async (work: () => Promise<void>) => work(),
}));
vi.mock("@/lib/google/oauth", () => ({
  oauthClient: () => ({ getToken: mocks.getToken, verifyIdToken: mocks.verifyIdToken }),
  GOOGLE_SCOPES: ["openid", "email", "https://www.googleapis.com/auth/calendar.events"],
}));
vi.mock("@/lib/sync/worker", () => ({ safelyProcessJobs: vi.fn() }));
vi.mock("@/lib/google/grant-lock", () => ({ withGoogleGrantLock: (work: () => Promise<unknown>) => work() }));

import { GET } from "@/app/api/google/callback/route";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";

function tokenResponse(scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events") {
  return { tokens: { id_token: "mock-id-token", access_token: "mock-access-token", refresh_token: "mock-refresh-token", expiry_date: Date.now() + 3600000, scope } };
}
function callback(state = "expected-state", extra = "code=mock-code") {
  return new Request(`http://localhost:3000/api/google/callback?state=${state}&${extra}`);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("GOOGLE_CLIENT_ID", "mock-client-id");
  vi.stubEnv("GOOGLE_CALENDAR_ID", "primary");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  const session = "mock-admin-session";
  const sealed = encryptToken(JSON.stringify({ state: "expected-state", expires: Date.now() + 60000, verifier: "mock-verifier", sessionHash: createHash("sha256").update(session).digest("hex") }), "oauth-state");
  mocks.cookies.mockResolvedValue({ get: (name: string) => ({ value: name === "chatbeds_google_state" ? sealed : session }) });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.getToken.mockResolvedValue(tokenResponse());
  mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "mock-account", email: "qa@example.com" }) });
  mocks.getCredentials.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("OAuth callback", () => {
  it("rejects mismatched state before token exchange or DB consumption", async () => {
    const response = await GET(callback("attacker"));
    expect(response.headers.get("location")).toContain("notice=oauth_state_invalid");
    expect(mocks.getToken).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects an already consumed state before token exchange", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await GET(callback())).headers.get("location")).toContain("notice=oauth_state_invalid");
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("connects with event permission, encrypts tokens, and schedules queued work", async () => {
    const response = await GET(callback());
    expect(response.headers.get("location")).toContain("notice=connected");
    expect(mocks.getToken).toHaveBeenCalledWith({ code: "mock-code", codeVerifier: "mock-verifier" });
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: "mock-id-token", audience: "mock-client-id" });
    const saved = mocks.saveCredentials.mock.calls[0][0];
    expect(decryptToken(saved.access_token_encrypted, "mock-account:access")).toBe("mock-access-token");
    expect(decryptToken(saved.refresh_token_encrypted, "mock-account:refresh")).toBe("mock-refresh-token");
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(response.headers.get("location")).not.toContain("mock-access-token");
  });

  it.each(["openid https://www.googleapis.com/auth/userinfo.email", "openid https://www.googleapis.com/auth/calendar.readonly", ""])(
    "shows actionable missing-permission feedback and saves no credentials for partial consent (%s)", async scope => {
      mocks.getToken.mockResolvedValue(tokenResponse(scope));
      const response = await GET(callback());
      expect(response.headers.get("location")).toContain("notice=oauth_calendar_permission_missing");
      expect(mocks.saveCredentials).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
      expect(mocks.logSync).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining("select permission to view and edit events") }), "sandbox");
    },
  );

  it("records safe generic failures without exposing provider details or credentials", async () => {
    mocks.getToken.mockRejectedValue(new Error("provider-body-with-mock-client-secret"));
    const response = await GET(callback());
    expect(response.headers.get("location")).toContain("notice=oauth_failed");
    expect(JSON.stringify(mocks.logSync.mock.calls)).not.toContain("mock-client-secret");
    expect(mocks.saveCredentials).not.toHaveBeenCalled();
  });
  it("binds Google credentials to the original property even if the dashboard selector changes during consent",async()=>{
    const session="mock-admin-session",integrationId="c2205d78-c0e7-4d92-94be-9b91e1ab42ab";
    const sealed=encryptToken(JSON.stringify({state:"expected-state",expires:Date.now()+60000,verifier:"mock-verifier",integrationId,sessionHash:createHash("sha256").update(session).digest("hex")}),"oauth-state");
    mocks.cookies.mockResolvedValue({get:(name:string)=>({value:name==="chatbeds_google_state"?sealed:name==="chatbeds_installation"?encryptToken("sandbox","selected-installation"):session})});
    expect((await GET(callback())).headers.get("location")).toContain("notice=connected");expect(mocks.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({integration_id:integrationId}));
    expect(mocks.getCredentials).toHaveBeenCalledWith(integrationId);
  });
});
