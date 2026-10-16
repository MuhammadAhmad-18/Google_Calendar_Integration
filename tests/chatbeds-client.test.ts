import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBedsClient } from "@/lib/chatbeds/client";
import { reservation } from "./fixtures";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("documented ChatBeds API calls", () => {
  it("reads /me, exact-arrival search with limit=100, and /reservations/id using Bearer auth", async () => {
    vi.stubEnv("CHATBEDS_API_BASE_URL", "https://mock-chatbeds.invalid/partner/v1");
    const http = vi.fn()
      .mockResolvedValueOnce(Response.json({ property: { id: reservation.property_id, name: "Sandbox Hotel" } }))
      .mockResolvedValueOnce(Response.json({ reservations: [reservation] }))
      .mockResolvedValueOnce(Response.json({ reservation }));
    vi.stubGlobal("fetch", http);
    const client = new ChatBedsClient({ getAccessCredential: async () => "mock-credential" });
    await client.me(); await client.search(reservation.property_id, "2026-10-31", "confirmed"); await client.reservation(reservation.id);
    expect(http.mock.calls[0][0]).toBe("https://mock-chatbeds.invalid/partner/v1/me");
    const url = new URL(http.mock.calls[1][0]);
    expect(url.pathname).toBe(`/partner/v1/properties/${reservation.property_id}/reservations`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ arrival: "2026-10-31", limit: "100", status: "confirmed" });
    expect(http.mock.calls[2][0]).toBe(`https://mock-chatbeds.invalid/partner/v1/reservations/${reservation.id}`);
    expect(http.mock.calls[0][1].headers.Authorization).toBe("Bearer mock-credential");
  });
  it("sanitizes provider errors and never forwards secrets", async () => {
    vi.stubEnv("CHATBEDS_API_BASE_URL", "https://mock-chatbeds.invalid/partner/v1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "mock-secret-should-not-escape" }, { status: 401 })));
    const client = new ChatBedsClient({ getAccessCredential: async () => "mock-credential" });
    await expect(client.me()).rejects.toThrow("invalid, expired or revoked");
    try { await client.me(); } catch (error) { expect(String(error)).not.toContain("mock-secret"); }
  });
});
