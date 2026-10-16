import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({ getCredentials: vi.fn(), saveCredentials: vi.fn(), request: vi.fn(), getAccessToken: vi.fn() }));
vi.mock("@/lib/db/store", () => ({ getCredentials: mocks.getCredentials, saveCredentials: mocks.saveCredentials }));
vi.mock("@/lib/google/grant-lock", () => ({ withGoogleGrantLock: (work: () => Promise<unknown>) => work() }));
vi.mock("google-auth-library", () => ({ OAuth2Client: class extends EventEmitter {
  transporter = { interceptors: { request: { add: vi.fn() } } };
  setCredentials() {}
  async getAccessToken() { return mocks.getAccessToken(this); }
  async request(options: unknown) { return mocks.request(this, options); }
} }));
import { authorizedGoogle, persistTokens, revokeGoogleToken } from "@/lib/google/oauth";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import type { GoogleCredentials } from "@/lib/db/types";
function row(): GoogleCredentials {
  return { integration_id: "sandbox", account_sub: "mock-sub", account_email: "test@example.com", calendar_id: "primary", access_token_encrypted: encryptToken("old-access", "mock-sub:access"), refresh_token_encrypted: encryptToken("old-refresh", "mock-sub:refresh"), expires_at: 1 };
}
function configure() {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("GOOGLE_CLIENT_ID", "mock-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "mock-secret"); vi.stubEnv("GOOGLE_REDIRECT_URI", "https://integration.example/api/google/callback");
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe("Google refresh-token handling", () => {
  it("preserves an existing refresh token when the provider only returns access credentials", async () => {
    configure(); const saved = row();
    const next = await persistTokens(saved, { access_token: "new-access", expiry_date: 10000 });
    expect(decryptToken(next.access_token_encrypted, "mock-sub:access")).toBe("new-access");
    expect(next.refresh_token_encrypted).toBe(saved.refresh_token_encrypted);
    expect(next.expires_at).toBe(10000);
  });
  it("persists refreshed credentials before using the Calendar API", async () => {
    configure(); mocks.getCredentials.mockResolvedValue(row()); mocks.saveCredentials.mockResolvedValue(undefined);
    mocks.getAccessToken.mockImplementation(async (client: EventEmitter) => { client.emit("tokens", { access_token: "new-access", expiry_date: 50000 }); });
    mocks.request.mockImplementation(async () => { expect(mocks.saveCredentials).toHaveBeenCalledTimes(1); return { data: { id: "event" } }; });
    const google = await authorizedGoogle();
    expect(await google.request({ url: "https://mock.invalid/events" })).toEqual({ id: "event" });
    const saved = mocks.saveCredentials.mock.calls[0][0] as GoogleCredentials;
    expect(decryptToken(saved.access_token_encrypted, "mock-sub:access")).toBe("new-access");
    expect(decryptToken(saved.refresh_token_encrypted, "mock-sub:refresh")).toBe("old-refresh");
  });
  it("rejects calendar access while disconnected", async () => { configure(); mocks.getCredentials.mockResolvedValue(null); await expect(authorizedGoogle()).rejects.toThrow("not connected"); expect(mocks.request).not.toHaveBeenCalled(); });
  it("does not restore revoked credentials when another property disconnects the same Google account", async () => {
    configure(); mocks.getCredentials.mockResolvedValueOnce(row()).mockResolvedValue(null);
    const google = await authorizedGoogle();
    await expect(google.request({ url: "https://mock.invalid/events" })).rejects.toThrow("not connected");
    expect(mocks.getAccessToken).not.toHaveBeenCalled(); expect(mocks.saveCredentials).not.toHaveBeenCalled();
  });
  it("revokes with a POST body and keeps tokens out of URLs", async () => {
    const http = vi.fn().mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal("fetch", http);
    await revokeGoogleToken("mock-refresh-token");
    expect(http.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(http.mock.calls[0][1].method).toBe("POST"); expect(http.mock.calls[0][1].body.toString()).toBe("token=mock-refresh-token");
  });
});
