import type { Reservation } from "../chatbeds/types";
import type { CalendarMap } from "../db/types";
import type { MappingStore } from "../db/store";
import { buildEvent, contentHash, eventId } from "../google/event-builder";
import { providerStatus, type CalendarGateway } from "../google/calendar";

export type SyncAction = "create" | "update" | "delete" | "skip";
export interface SyncResult { action: SyncAction; eventId: string | null; message: string; }
export interface SyncDependencies { maps: MappingStore; calendar: CalendarGateway; accountSub: string; calendarId: string; integrationId?: string; }

// All callers hold the durable installation lease before invoking this function.
export async function syncReservation(r: Reservation, deps: SyncDependencies): Promise<SyncResult> {
  const { maps, calendar, accountSub, calendarId } = deps;
  let map = await maps.find(r.id, r.property_id, accountSub, calendarId);
  if (map && Date.parse(r.updated_at) < Date.parse(map.reservation_updated_at)) {
    return { action: "skip", eventId: map.google_event_id, message: "Older reservation version ignored." };
  }
  const now = new Date().toISOString();
  const event = buildEvent(r);
  const hash = contentHash(event);
  const base = { integration_id: deps.integrationId ?? "sandbox", property_id: r.property_id, reservation_id: r.id, reservation_ref: r.ref, account_sub: accountSub, calendar_id: calendarId, arrival: r.arrival, departure: r.departure, reservation_status: r.status, reservation_updated_at: r.updated_at };
  if (r.status === "cancelled" || r.status === "no_show") {
    if (!map) return { action: "skip", eventId: null, message: "Cancelled reservation has no mapped event." };
    // Even an unfinished insert may have created an event before its response failed.
    try { await calendar.remove(map.google_event_id); }
    catch (error) { if (![404, 410].includes(providerStatus(error))) throw error; }
    await maps.save({ ...map, ...base, active: false, content_hash: null, last_synced_at: now });
    return { action: "delete", eventId: map.google_event_id, message: "Cancelled/no-show event removed (or already absent)." };
  }
  let remoteExists = false;
  let tombstone = false;
  if (map) {
    try { const remote = await calendar.get(map.google_event_id); tombstone = remote.status === "cancelled"; remoteExists = !tombstone; }
    catch (error) {
      const status = providerStatus(error);
      if (![404, 410].includes(status)) throw error;
      tombstone = status === 410;
    }
    if (remoteExists && map.active && map.content_hash === hash) {
      await maps.save({ ...map, ...base, last_synced_at: now });
      return { action: "skip", eventId: map.google_event_id, message: "Reservation is already synchronized." };
    }
    if (remoteExists) {
      await calendar.update(map.google_event_id, event);
      await maps.save({ ...map, ...base, active: true, content_hash: hash, last_synced_at: now });
      return { action: "update", eventId: map.google_event_id, message: "Existing event updated." };
    }
  }
  const generation = (map?.generation ?? 0) + (tombstone ? 1 : 0);
  const id = eventId(r.property_id, r.id, accountSub, calendarId, generation);
  map = { ...base, generation, google_event_id: id, active: false, content_hash: null, last_synced_at: null } satisfies CalendarMap;
  // Save the intended ID before insert. A timeout or DB error after insert retries
  // this exact ID; 409 means the previous attempt succeeded.
  await maps.save(map);
  try { await calendar.insert(id, event); }
  catch (error) {
    if (providerStatus(error) !== 409) throw error;
    const existing = await calendar.get(id);
    if (existing.status === "cancelled") {
      // A deleted Google event retains its ID. Persist a new generation first.
      map = { ...map, generation: generation + 1, google_event_id: eventId(r.property_id, r.id, accountSub, calendarId, generation + 1) };
      await maps.save(map);
      await calendar.insert(map.google_event_id, event);
    } else await calendar.update(id, event);
  }
  await maps.save({ ...map, active: true, content_hash: hash, last_synced_at: now });
  return { action: "create", eventId: map.google_event_id, message: "Event created or recovered from a previous attempt." };
}
