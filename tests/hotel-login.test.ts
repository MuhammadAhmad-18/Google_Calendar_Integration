import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), signOut: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth/hotel-client", () => ({ hotelAuthClient: async () => ({ auth: { signOut: mocks.signOut } }) }));
import { POST as send } from "@/app/api/auth/request-code/route";
import { POST as verify } from "@/app/api/auth/verify-code/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { NextResponse } from "next/server";
import { appAccessMode, configurationReadiness, publicBranding } from "@/lib/config";
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ACCESS_MODE", "public"); vi.stubEnv("CHATBEDS_AUTH_MODE", "oauth");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://integration.example"); vi.stubEnv("SESSION_SECRET", "mock-session-secret-more-than-thirty-two-characters");
  mocks.cookies.mockResolvedValue({ getAll: () => [{ name: "sb-project-auth-token", value: "mock-token" }] });
});
afterEach(() => vi.unstubAllEnvs());
function request(origin = "https://integration.example") { return new Request("https://integration.example/api/auth/test", { method: "POST", headers: { origin } }); }
describe("Google-only public sign-in migration", () => {
  it.each([send,verify])("retires email codes without sending email or creating a session", async handler => {
    const response = await handler(request());
    expect(response.status).toBe(410); expect(await response.text()).toContain("Continue with Google");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it.each([send,verify,logout])("rejects cross-origin attempts", async handler => { expect((await handler(request("https://attacker.example"))).status).toBe(403); });
  it("clears app, onboarding and Auth cookies even during an authentication outage", async () => {
    mocks.signOut.mockRejectedValue(new Error("mock outage"));
    const response = await logout(request()) as NextResponse;
    expect(response.status).toBe(200); expect(response.cookies.get("chatbeds_admin")?.maxAge).toBe(0);
    expect(response.cookies.get("sb-project-auth-token")?.value).toBe("");
    expect(response.cookies.get("chatbeds_google_setup")?.maxAge).toBe(0);
  });
  it("requires OAuth and Supabase Auth, never the shared admin password", () => {
    expect(configurationReadiness(["SUPABASE_PUBLISHABLE_KEY"])).toEqual({ googleReady: false, syncReady: false });
    expect(configurationReadiness(["ADMIN_PASSWORD"])).toEqual({ googleReady: true, syncReady: true });
    vi.stubEnv("CHATBEDS_AUTH_MODE", "api_key"); expect(() => appAccessMode()).toThrow(/App OAuth/);
  });
  it("does not publish placeholder operator identities", () => { vi.stubEnv("PUBLIC_OPERATOR_NAME", "REPLACE_ME"); expect(publicBranding().operator).toBeNull(); });
});
