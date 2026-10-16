import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), cookies: vi.fn(), getIntegration: vi.fn(), insert: vi.fn(), generateAuthUrl: vi.fn(), generateCodeVerifierAsync: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth/session", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/auth/session")>(), requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/db/store", () => ({ getIntegration: mocks.getIntegration }));
vi.mock("@/lib/db/client", () => ({ db: () => ({ from: () => ({ insert: mocks.insert }) }), checked: (result: { data: unknown }) => result.data }));
vi.mock("@/lib/google/oauth", () => ({
  GOOGLE_SCOPES: ["openid", "email", "https://www.googleapis.com/auth/calendar.events"],
  oauthClient: () => ({ generateCodeVerifierAsync: mocks.generateCodeVerifierAsync, generateAuthUrl: mocks.generateAuthUrl }),
}));

import { POST } from "@/app/api/google/connect/route";
import { decryptToken } from "@/lib/crypto/tokens";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 6).toString("base64"));
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "mock-admin-session" }) });
  mocks.getIntegration.mockResolvedValue({ property_id: "mock-sandbox-property" });
  mocks.insert.mockResolvedValue({ data: null, error: null });
  mocks.generateCodeVerifierAsync.mockResolvedValue({ codeVerifier: "mock-verifier", codeChallenge: "mock-challenge" });
  mocks.generateAuthUrl.mockReturnValue("https://mock-google.invalid/authorize");
});
afterEach(() => vi.unstubAllEnvs());

describe("Google Connect form origin protection", () => {
  it("starts OAuth for a legitimate form POST and binds encrypted state to the admin session", async () => {
    const response = await POST(new Request("http://localhost:3000/api/google/connect", { method: "POST", headers: { origin: "http://localhost:3000" } }));
    expect(response.status).toBe(303);
    if (!(response instanceof NextResponse)) throw new Error("Expected the OAuth redirect response.");
    expect(response.headers.get("location")).toBe("https://mock-google.invalid/authorize");
    const options = mocks.generateAuthUrl.mock.calls[0][0];
    expect(options).toMatchObject({ access_type: "offline", code_challenge: "mock-challenge", code_challenge_method: "S256" });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ state_hash: createHash("sha256").update(options.state).digest("hex") }));
    const cookie = response.cookies.get("chatbeds_google_state")!;
    const state = JSON.parse(decryptToken(cookie.value, "oauth-state"));
    expect(state).toMatchObject({ state: options.state, verifier: "mock-verifier", sessionHash: createHash("sha256").update("mock-admin-session").digest("hex") });
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
  });

  it.each([null, "null", "https://attacker.example", "http://127.0.0.1:3000"])(
    "rejects a missing, opaque or different origin (%s) before starting OAuth", async origin => {
      const response = await POST(new Request("http://localhost:3000/api/google/connect", { method: "POST", headers: origin === null ? {} : { origin } }));
      expect(response.status).toBe(403);
      expect(mocks.getIntegration).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.generateAuthUrl).not.toHaveBeenCalled();
    },
  );
});
