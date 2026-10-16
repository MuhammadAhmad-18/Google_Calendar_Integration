import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), getUser: vi.fn(), from: vi.fn(), rpc: vi.fn(), getToken: vi.fn(), after: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/auth/hotel-client", () => ({ hotelAuthClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/db/client", async original => ({ ...await original<typeof import("@/lib/db/client")>(), db: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/google/oauth", async original => ({ ...await original<typeof import("@/lib/google/oauth")>(), oauthClient: () => ({ getToken: mocks.getToken }) }));
import { createHotelSession, validHotelSession, workspaceUser } from "@/lib/auth/session";
import { assertInstallationAccess, visibleInstallations } from "@/lib/auth/tenancy";
import { selectedIntegrationId } from "@/lib/auth/installation";
import { encryptToken } from "@/lib/crypto/tokens";
import { installChatBeds } from "@/lib/chatbeds/token-store";
import { POST as select } from "@/app/api/integrations/select/route";
import { POST as chatbedsDisconnect } from "@/app/api/chatbeds/disconnect/route";
import { POST as chatbedsTest } from "@/app/api/chatbeds/test/route";
import { POST as sync } from "@/app/api/chatbeds/sync/route";
import { POST as googleConnect } from "@/app/api/google/connect/route";
import { POST as googleDisconnect } from "@/app/api/google/disconnect/route";
import { GET as googleCallback } from "@/app/api/google/callback/route";
import { GET as status } from "@/app/api/status/route";
import { POST as retry } from "@/app/api/jobs/process/route";
import { POST as adminLogin } from "@/app/api/admin/login/route";
import { GET as install } from "@/app/api/chatbeds/install/route";
const user = "11111111-1111-4111-8111-111111111111";
let cookieValues: Record<string,string>, owned: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ACCESS_MODE", "public"); vi.stubEnv("CHATBEDS_AUTH_MODE", "oauth");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32,8).toString("base64")); vi.stubEnv("SESSION_SECRET", "mock-session-secret-over-thirty-two-characters");
  cookieValues = { chatbeds_admin: createHotelSession(user) }; owned = ["hotel-a"];
  mocks.cookies.mockImplementation(async () => ({ get: (name: string) => cookieValues[name] ? { value: cookieValues[name] } : undefined }));
  mocks.getUser.mockResolvedValue({ data: { user: { id: user, email: "hotel-a@example.com", email_confirmed_at: "2026-10-12" } }, error: null });
  mocks.rpc.mockResolvedValue({ data: "hotel-a", error: null });
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string,string> = {};
    const query = {
      select: vi.fn(() => query), eq: vi.fn((key: string, value: string) => { filters[key] = value; return query; }),
      in: vi.fn((key: string, values: string[]) => { filters[key] = values.join(","); return query; }),
      order: vi.fn(() => query), limit: vi.fn(() => query), or: vi.fn(() => query), lte: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: table === "integration_members" ? owned.includes(filters.integration_id) ? { integration_id: filters.integration_id } : null : table === "integration_settings" ? { id: "hotel-b" } : null, error: null })),
      single: vi.fn(async () => ({ data: { id: filters.id, property_id: filters.id, chatbeds_status: "connected" }, error: null })),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "integration_members" ? owned.map(integration_id => ({ integration_id })) : table === "integration_settings" ? owned.map(id => ({ id, property_id: id })) : [], error: null }).then(resolve),
    };
    return query;
  });
});
afterEach(() => vi.unstubAllEnvs());
function request(path: string, body?: unknown) { return new Request(`http://localhost:3000/api/${path}`, { method: "POST", headers: { origin: "http://localhost:3000", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
describe("Hotel identity and access boundaries", () => {
  it("binds signed sessions to a verified identity and rejects tampering/expiry", async () => {
    const sealed = createHotelSession(user,1000);
    expect(validHotelSession(sealed,user,2000)).toBe(true);
    expect(validHotelSession(sealed,"another-user",2000)).toBe(false);
    expect(validHotelSession(sealed+"x",user,2000)).toBe(false);
    expect(validHotelSession(sealed,user,1000+8*3600000)).toBe(false);
    expect((await workspaceUser())?.id).toBe(user);
  });
  it("rejects a valid signed cookie when Supabase rejects or has not verified the user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid" } }); expect(await workspaceUser()).toBeNull();
    mocks.getUser.mockResolvedValue({ data: { user: { id: user, email_confirmed_at: null } }, error: null }); expect(await workspaceUser()).toBeNull();
  });
  it("rejects a session copied from another user", async () => {
    cookieValues.chatbeds_admin = createHotelSession("22222222-2222-4222-8222-222222222222");
    expect(await workspaceUser()).toBeNull();
  });
  it("checks database membership even for a correctly encrypted property cookie", async () => {
    cookieValues.chatbeds_installation = encryptToken("hotel-b", "selected-installation");
    await expect(selectedIntegrationId()).rejects.toMatchObject({ status: 404 });
    await expect(assertInstallationAccess("hotel-b")).rejects.toMatchObject({ status: 404 });
    await expect(assertInstallationAccess("hotel-a")).resolves.toBeUndefined();
  });
  it("never falls back to a shared sandbox for new hotel users", async () => { expect(await selectedIntegrationId()).toBe("hotel-a"); expect(mocks.rpc).toHaveBeenCalledWith("ensure_hotel_workspace", { p_user_id: user }); });
  it("lists only the verified user's member installations", async () => {
    expect(await visibleInstallations()).toEqual([{ id: "hotel-a", property_id: "hotel-a" }]);
    const settings = mocks.from.mock.results.find((_,i) => mocks.from.mock.calls[i][0] === "integration_settings")!.value;
    expect(settings.in).toHaveBeenCalledWith("id", ["hotel-a"]);
  });
  it.each([select,chatbedsDisconnect,chatbedsTest,sync,googleConnect,googleDisconnect,retry])("rejects other-hotel mutations before jobs/tokens/provider calls", async handler => {
    cookieValues.chatbeds_installation = encryptToken("hotel-b", "selected-installation");
    expect((await handler(request("test", { integrationId: "hotel-b", from: "2026-10-12", to: "2026-10-12" }))).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.getToken).not.toHaveBeenCalled();
  });
  it("rejects other-hotel status before reading logs or credentials", async () => {
    cookieValues.chatbeds_installation = encryptToken("hotel-b", "selected-installation");
    expect((await status()).status).toBe(404);
    expect(mocks.from.mock.calls.map(call => call[0])).not.toContain("google_credentials");
    expect(mocks.from.mock.calls.map(call => call[0])).not.toContain("sync_logs");
  });
  it("returns only own properties and hides deployment configuration in customer status", async () => {
    cookieValues.chatbeds_installation = encryptToken("hotel-a", "selected-installation");
    vi.stubEnv("CHATBEDS_WEBHOOK_URL", "https://private-operator-endpoint.example/webhook");
    const response = await status(); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await response.json();
    expect(result.installations).toEqual([{ id: "hotel-a", property_id: "hotel-a" }]);
    expect(result.configuration).toMatchObject({ publicMode: true, missing: [], webhookUrl: null });
    expect(result.logs).toEqual([]); expect(result.jobs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-operator-endpoint");
  });
  it("rechecks Google callback ownership before exchanging a code, writing logs or setting a selected property", async () => {
    const sealed = encryptToken(JSON.stringify({ state: "issued", verifier: "mock", expires: Date.now()+60000, integrationId: "hotel-b", sessionHash: createHash("sha256").update(cookieValues.chatbeds_admin).digest("hex") }), "oauth-state");
    cookieValues.chatbeds_google_state = sealed; mocks.rpc.mockResolvedValue({ data: true, error: null });
    const response = await googleCallback(new Request("http://localhost:3000/api/google/callback?state=issued&code=mock"));
    expect(response.headers.get("location")).toContain("/dashboard?notice=oauth_failed");
    expect(mocks.getToken).not.toHaveBeenCalled(); expect(response.headers.get("set-cookie")).not.toContain("chatbeds_installation");
    expect(mocks.from.mock.calls.map(call => call[0])).not.toContain("sync_logs");
  });
  it("does not overwrite another hotel's ChatBeds credential pair on reconnect", async () => {
    await expect(installChatBeds({ property_id: "mock-property", installation_id: "mock-install", access_token: "cbat_mock", refresh_token: "cbrt_mock", expires_in: 3600, scope: "reservations:read", token_type: "Bearer" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("disables the shared-password login endpoint in public mode", async () => { expect((await adminLogin(request("admin/login", { password: "mock-old-password" }))).status).toBe(403); expect(mocks.rpc).not.toHaveBeenCalled(); });
  it("resumes a directory installation through the personal login screen", async () => {
    cookieValues = {};
    const response = await install(); const url = new URL(response.headers.get("location")!);
    expect(url.pathname).toBe("/login"); expect(url.searchParams.get("next")).toBe("/api/chatbeds/install");
  });
});
