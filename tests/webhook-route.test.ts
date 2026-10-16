import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { reservation } from "./fixtures";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), after: vi.fn(), worker: vi.fn(), installation: null as Record<string,unknown> | null }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/db/client", () => ({ db: () => ({ rpc: mocks.rpc,from:()=>{const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:mocks.installation})};return query;} }), checked: (r: { data: unknown; error: unknown }) => { if (r.error) throw new Error("mock failure"); return r.data; } }));
vi.mock("@/lib/db/store", () => ({ integrationColumns:"id,property_id", getIntegration: async () => ({ id: "sandbox", property_id: reservation.property_id }) }));
vi.mock("@/lib/sync/worker", () => ({ safelyProcessJobs: mocks.worker }));
import { POST } from "@/app/api/webhooks/chatbeds/route";
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("Vercel webhook handler", () => {
  const id = "c8839bfe-aa2f-4ac4-9847-d30e112516d6";
  const body = JSON.stringify({ id, type: "reservation.created", created_at: "2026-10-10T05:09:47Z", property_id: reservation.property_id, data: { reservation } });
  function request(valid = true) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "mock-webhook-secret").update(`${timestamp}.${body}`).digest("hex");
    return new Request("https://integration.example/api/webhooks/chatbeds", { method: "POST", body,
      headers: { "ChatBeds-Signature": `t=${timestamp},v1=${valid ? signature : "0".repeat(64)}`, "ChatBeds-Delivery": id, "ChatBeds-Event": "reservation.created" } });
  }
  it("rejects invalid signature before database or calendar access", async () => {
    vi.stubEnv("CHATBEDS_WEBHOOK_SECRET", "mock-webhook-secret");
    expect((await POST(request(false))).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
  });
  it.each([true, false])("acknowledges durable insert/duplicate without awaiting Google (%s)", async inserted => {
    vi.stubEnv("CHATBEDS_WEBHOOK_SECRET", "mock-webhook-secret"); mocks.rpc.mockResolvedValue({ data: inserted, error: null });
    expect((await POST(request())).status).toBe(204);
    expect(mocks.rpc).toHaveBeenCalledWith("enqueue_installation_webhook", { p_integration_id: "sandbox", p_delivery_id: id, p_event_type: "reservation.created", p_property_id: reservation.property_id, p_reservation_id: reservation.id });
    expect(mocks.after).toHaveBeenCalledWith(expect.any(Function)); expect(mocks.worker).not.toHaveBeenCalled();
  });
  it("does not return success if durable enqueue fails", async () => {
    vi.stubEnv("CHATBEDS_WEBHOOK_SECRET", "mock-webhook-secret"); mocks.rpc.mockResolvedValue({ data: null, error: { message: "failure" } });
    expect((await POST(request())).status).toBe(500); expect(mocks.after).not.toHaveBeenCalled();
  });
  it("routes a signed app webhook to its authorized installation instead of sandbox",async()=>{
    vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");vi.stubEnv("CHATBEDS_WEBHOOK_SECRET","mock-webhook-secret");
    mocks.installation={id:"other-installation",property_id:reservation.property_id,chatbeds_status:"connected"};mocks.rpc.mockResolvedValue({data:true});
    expect((await POST(request())).status).toBe(204);expect(mocks.rpc).toHaveBeenCalledWith("enqueue_installation_webhook",expect.objectContaining({p_integration_id:"other-installation"}));
    await mocks.after.mock.calls[0][0]();expect(mocks.worker).toHaveBeenCalledWith("other-installation");
  });
  it("acknowledges unregistered app properties without accessing Google",async()=>{
    vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");vi.stubEnv("CHATBEDS_WEBHOOK_SECRET","mock-webhook-secret");mocks.installation=null;
    expect((await POST(request())).status).toBe(204);expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.after).not.toHaveBeenCalled();
  });
  it("durably retains late deliveries after disconnect without starting a worker",async()=>{
    vi.stubEnv("CHATBEDS_AUTH_MODE","oauth");vi.stubEnv("CHATBEDS_WEBHOOK_SECRET","mock-webhook-secret");mocks.installation={id:"other-installation",property_id:reservation.property_id,chatbeds_status:"disconnected"};mocks.rpc.mockResolvedValue({data:true});
    expect((await POST(request())).status).toBe(204);expect(mocks.rpc).toHaveBeenCalledOnce();expect(mocks.after).not.toHaveBeenCalled();
  });
});
