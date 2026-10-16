import { describe, expect, it, vi } from "vitest";
import { acceptDelivery, parseDelivery } from "@/lib/sync/webhook-delivery";
import { reservation } from "./fixtures";
const deliveryId = "c8839bfe-aa2f-4ac4-9847-d30e112516d6";
const payload = { id: deliveryId, type: "reservation.created", created_at: "2026-10-10T05:09:47Z", property_id: reservation.property_id, data: { reservation } };
describe("webhook validation and duplicate protection", () => {
  it("accepts documented event shape and validates signed/header IDs and property", () => {
    const delivery = parseDelivery(payload, deliveryId, reservation.property_id, payload.type);
    expect(delivery.reservationId).toBe(reservation.id);
    expect(() => parseDelivery(payload, "wrong", reservation.property_id, payload.type)).toThrow();
    expect(() => parseDelivery(payload, deliveryId, "wrong", payload.type)).toThrow();
    expect(() => parseDelivery(payload, deliveryId, reservation.property_id, "wrong")).toThrow();
  });
  it("only enqueues one job for concurrent duplicate deliveries", async () => {
    const stored = new Set<string>(); let queueCount = 0;
    // Models the single atomic SQL RPC, rather than a read-then-write race.
    const enqueue = vi.fn(async (delivery: { deliveryId: string }) => {
      if (stored.has(delivery.deliveryId)) return false;
      stored.add(delivery.deliveryId); queueCount++; return true;
    });
    const delivery = parseDelivery(payload, deliveryId, reservation.property_id, payload.type);
    const results = await Promise.all([acceptDelivery(delivery, enqueue), acceptDelivery(delivery, enqueue)]);
    expect(queueCount).toBe(1); expect(results.filter(r => r.duplicate)).toHaveLength(1);
  });
  it("does not acknowledge successful acceptance if durable enqueue fails", async () => {
    const delivery = parseDelivery(payload, deliveryId, reservation.property_id, payload.type);
    await expect(acceptDelivery(delivery, async () => { throw new Error("mock DB unavailable"); })).rejects.toThrow();
  });
  it("ignores unknown future events without assuming their data shape", () => {
    const delivery = parseDelivery({ ...payload, type: "future.event", data: null }, deliveryId, reservation.property_id, "future.event");
    expect(delivery.reservationId).toBeNull();
  });
  it("rejects malformed known reservation payloads", () => {
    expect(() => parseDelivery({ ...payload, data: { reservation: { id: reservation.id } } }, deliveryId, reservation.property_id, payload.type)).toThrow();
  });
});
