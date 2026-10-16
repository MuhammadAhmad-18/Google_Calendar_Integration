import { describe, expect, it, vi } from "vitest";
import { buildEvent, eventId } from "@/lib/google/event-builder";
import { CalendarError, type CalendarGateway } from "@/lib/google/calendar";
import { syncReservation, type SyncDependencies } from "@/lib/sync/sync-reservation";
import type { CalendarMap } from "@/lib/db/types";
import { dateRange, nextDate } from "@/lib/sync/initial-sync";
import { reservation } from "./fixtures";

function harness() {
  let map: CalendarMap | null = null;
  const events = new Map<string, { id: string; status?: string; body: unknown }>();
  const calendar: CalendarGateway = {
    get: vi.fn(async id => { const event = events.get(id); if (!event) throw new CalendarError(404); return event; }),
    insert: vi.fn(async (id, body) => { if (events.has(id)) throw new CalendarError(409); events.set(id, { id, body }); }),
    update: vi.fn(async (id, body) => { if (!events.has(id)) throw new CalendarError(404); events.set(id, { id, body }); }),
    remove: vi.fn(async id => { if (!events.has(id)) throw new CalendarError(404); events.set(id, { id, body: null, status: "cancelled" }); }),
  };
  const deps: SyncDependencies = { calendar, accountSub: "mock-sub", calendarId: "primary", maps: { find: vi.fn(async () => map), save: vi.fn(async value => { map = { ...value }; }) } };
  return { deps, events, map: () => map };
}
describe("reservation to event", () => {
  it("uses all-day dates with exclusive departure and excludes contacts/payment data", () => {
    const input = { ...reservation, guest: { ...reservation.guest, email: "private@example.com", phone: "private-phone" }, total: 900 };
    const event = buildEvent(input);
    expect(event.start).toEqual({ date: "2026-10-31" }); expect(event.end).toEqual({ date: "2026-11-02" });
    expect(event.summary).toBe("Test Guest — Standard");
    expect(JSON.stringify(event)).not.toMatch(/private@example|private-phone|900/);
    expect(event.extendedProperties.private.chatbedsReservationId).toBe(reservation.id);
  });
  it("produces stable valid event IDs separated by account, property, calendar, and generation", () => {
    const id = eventId("p", "r", "a", "c", 0);
    expect(id).toMatch(/^[0-9a-v]{64}$/); expect(eventId("p", "r", "a", "c", 0)).toBe(id);
    expect(new Set([id, eventId("p2", "r", "a", "c", 0), eventId("p", "r", "a2", "c", 0), eventId("p", "r", "a", "c2", 0), eventId("p", "r", "a", "c", 1)]).size).toBe(5);
  });
});
describe("central synchronization", () => {
  it("creates once and skips repeated identical reservation states", async () => {
    const h = harness();
    expect((await syncReservation(reservation, h.deps)).action).toBe("create");
    expect((await syncReservation(reservation, h.deps)).action).toBe("skip");
    expect(h.deps.calendar.insert).toHaveBeenCalledTimes(1); expect(h.events.size).toBe(1);
    expect(h.map()?.active).toBe(true);
  });
  it("updates the mapped event for modified dates/unit and does not insert again", async () => {
    const h = harness(); await syncReservation(reservation, h.deps); const id = h.map()!.google_event_id;
    const result = await syncReservation({ ...reservation, departure: "2026-11-03", updated_at: "2026-10-11T05:00:00+00:00", unit: { id: reservation.id, name: "101" } }, h.deps);
    expect(result.action).toBe("update"); expect(result.eventId).toBe(id); expect(h.deps.calendar.insert).toHaveBeenCalledTimes(1);
  });
  it.each(["cancelled", "no_show"] as const)("removes %s reservations and safely repeats", async status => {
    const h = harness(); await syncReservation(reservation, h.deps);
    const changed = { ...reservation, status, updated_at: "2026-10-11T05:00:00+00:00" };
    expect((await syncReservation(changed, h.deps)).action).toBe("delete");
    await syncReservation(changed, h.deps); expect(h.map()?.active).toBe(false);
  });
  it("skips cancellation without a mapping", async () => {
    const h = harness(); expect((await syncReservation({ ...reservation, status: "cancelled" }, h.deps)).action).toBe("skip"); expect(h.deps.calendar.insert).not.toHaveBeenCalled();
  });
  it("recreates a deleted Google event using a new persistent generation", async () => {
    const h = harness(); await syncReservation(reservation, h.deps); const oldId = h.map()!.google_event_id;
    await h.deps.calendar.remove(oldId);
    const result = await syncReservation(reservation, h.deps);
    expect(result.action).toBe("create"); expect(result.eventId).not.toBe(oldId); expect(h.map()?.generation).toBe(1);
    await syncReservation(reservation, h.deps); expect(h.deps.calendar.insert).toHaveBeenCalledTimes(2);
  });
  it("recreates a 404 missing mapped event", async () => {
    const h = harness(); await syncReservation(reservation, h.deps); h.events.clear();
    expect((await syncReservation(reservation, h.deps)).action).toBe("create"); expect(h.events.size).toBe(1);
  });
  it("recovers insertion that succeeded remotely but timed out before its response", async () => {
    const h = harness(); const original = h.deps.calendar.insert;
    h.deps.calendar.insert = vi.fn(async (id, body) => { await original(id, body); throw new CalendarError(0); });
    await expect(syncReservation(reservation, h.deps)).rejects.toThrow();
    h.deps.calendar.insert = original;
    await syncReservation(reservation, h.deps); expect(h.events.size).toBe(1); expect(h.map()?.active).toBe(true);
  });
  it("recovers a DB failure after Google inserted without a second event", async () => {
    const h = harness(); const save = h.deps.maps.save; let writes = 0;
    h.deps.maps.save = vi.fn(async value => { if (++writes === 2) throw new Error("mock DB outage"); await save(value); });
    await expect(syncReservation(reservation, h.deps)).rejects.toThrow();
    await syncReservation(reservation, h.deps); expect(h.events.size).toBe(1); expect(h.deps.calendar.insert).toHaveBeenCalledTimes(1);
  });
  it("keeps the mapping on Google deletion failure so a retry can remove it", async () => {
    const h = harness(); await syncReservation(reservation, h.deps);
    h.deps.calendar.remove = vi.fn(async () => { throw new CalendarError(503); });
    await expect(syncReservation({ ...reservation, status: "cancelled" }, h.deps)).rejects.toThrow(); expect(h.map()?.active).toBe(true);
  });
  it("rejects stale reservation versions instead of overwriting newer dates", async () => {
    const h = harness(); await syncReservation({ ...reservation, departure: "2026-11-05", updated_at: "2026-10-11T05:00:00Z" }, h.deps);
    expect((await syncReservation(reservation, h.deps)).action).toBe("skip"); expect(h.deps.calendar.update).not.toHaveBeenCalled();
  });
  it("synchronizes documented pending reservations", async () => { const h = harness(); expect((await syncReservation({ ...reservation, status: "pending" }, h.deps)).action).toBe("create"); });
  it("keeps property mappings and Google events separate when properties share a calendar",async()=>{
    const first=harness(),second=harness();second.deps.calendar=first.deps.calendar;
    first.deps.integrationId="first-installation";second.deps.integrationId="second-installation";
    const other={...reservation,property_id:"19306340-c7cf-465a-93d3-0b7873a7e85e"};
    const a=await syncReservation(reservation,first.deps),b=await syncReservation(other,second.deps);
    expect(a.eventId).not.toBe(b.eventId);expect(first.map()?.integration_id).toBe("first-installation");expect(second.map()?.integration_id).toBe("second-installation");
    await syncReservation({...other,status:"cancelled"},second.deps);
    expect(first.events.get(a.eventId!)?.status).not.toBe("cancelled");expect(first.events.get(b.eventId!)?.status).toBe("cancelled");expect(first.map()?.active).toBe(true);
  });
});
describe("manual date range", () => {
  it("accepts 90 inclusive dates and handles leap days", () => { expect(dateRange({ from: "2026-01-01", to: "2026-03-31" })).toEqual({ from: "2026-01-01", to: "2026-03-31" }); expect(nextDate("2028-02-28")).toBe("2028-02-29"); });
  it.each([{ from: "2026-01-01", to: "2026-04-01" }, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-04-01", to: "2026-03-01" }])("rejects invalid or excessive ranges", value => { expect(() => dateRange(value)).toThrow(); });
});
