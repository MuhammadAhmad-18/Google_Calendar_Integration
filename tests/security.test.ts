import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "@/lib/chatbeds/webhook";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { createSession, validSession, requireOrigin } from "@/lib/auth/session";
import { validOAuthState } from "@/lib/google/oauth-state";

afterEach(() => vi.unstubAllEnvs());
describe("ChatBeds signature", () => {
  const timestamp = 1791608987;
  const secret = "whsec_test_secret_for_docs";
  const raw = Buffer.from('{"id":"c8839bfe-aa2f-4ac4-9847-d30e112516d6","type":"reservation.created"}');
  it("accepts the official test vector with a simulated clock at the signing time", () => {
    expect(verifySignature(raw, `t=${timestamp},v1=6a3e3fbc70884d929d4e1aa13728bd3df7d6d1369d41214bed413987e8bc3085`, secret, timestamp)).toBe(true);
  });
  it("rejects altered bytes, wrong secret, malformed signatures, and missing headers", () => {
    const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
    const header = `t=${timestamp},v1=${signature}`;
    expect(verifySignature(Buffer.concat([raw, Buffer.from(" ")]), header, secret, timestamp)).toBe(false);
    expect(verifySignature(raw, header, "wrong", timestamp)).toBe(false);
    expect(verifySignature(raw, `t=${timestamp},v1=aa`, secret, timestamp)).toBe(false);
    expect(verifySignature(raw, null, secret, timestamp)).toBe(false);
  });
  it("rejects old and future timestamps while accepting unknown header parts", () => {
    const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
    const header = `future=version,t=${timestamp},v1=${signature}`;
    expect(verifySignature(raw, header, secret, timestamp + 301)).toBe(false);
    expect(verifySignature(raw, header, secret, timestamp - 301)).toBe(false);
    expect(verifySignature(raw, header, secret, timestamp + 300)).toBe(true);
  });
});
describe("token encryption", () => {
  function configure() { vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64")); }
  it("round trips, uses randomized ciphertext, and never stores plaintext", () => {
    configure();
    const encrypted = encryptToken("mock-token", "account:refresh");
    expect(decryptToken(encrypted, "account:refresh")).toBe("mock-token");
    expect(encrypted).not.toContain("mock-token");
    expect(encryptToken("mock-token", "account:refresh")).not.toBe(encrypted);
  });
  it("rejects wrong keys, tampering and ciphertext moved to a different account/context", () => {
    configure(); const encrypted = encryptToken("mock-token", "account:refresh");
    expect(() => decryptToken(encrypted, "other:refresh")).toThrow();
    const parts = encrypted.split("."); parts[2] = Buffer.alloc(16).toString("base64url");
    expect(() => decryptToken(parts.join("."), "account:refresh")).toThrow();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(() => decryptToken(encrypted, "account:refresh")).toThrow();
  });
  it("rejects invalid key configuration", () => { vi.stubEnv("TOKEN_ENCRYPTION_KEY", "short"); expect(() => encryptToken("x", "x")).toThrow(); });
});
describe("session and OAuth state", () => {
  it("rejects invalid, absent and expired OAuth state", () => {
    expect(validOAuthState("same", "same", 2000, 1000)).toBe(true);
    expect(validOAuthState("wrong", "same", 2000, 1000)).toBe(false);
    expect(validOAuthState(null, "same", 2000, 1000)).toBe(false);
    expect(validOAuthState("same", "same", 1000, 1000)).toBe(false);
  });
  it("rejects forged/expired sessions and invalidates them on password rotation", () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-more-than-32-characters");
    vi.stubEnv("ADMIN_PASSWORD", "mock-admin-password-with-long-entropy");
    const session = createSession(1000);
    expect(validSession(session, 2000)).toBe(true);
    expect(validSession(session + "changed", 2000)).toBe(false);
    expect(validSession(session, 1000 + 8 * 60 * 60 * 1000)).toBe(false);
    vi.stubEnv("ADMIN_PASSWORD", "rotated-mock-admin-password-with-long-entropy");
    expect(validSession(session, 2000)).toBe(false);
  });
  it("rejects cross-origin state changing requests", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://integration.example");
    expect(() => requireOrigin(new Request("https://integration.example/api", { headers: { origin: "https://attacker.example" } }))).toThrow();
    expect(() => requireOrigin(new Request("https://integration.example/api", { headers: { origin: "https://integration.example" } }))).not.toThrow();
  });
});
