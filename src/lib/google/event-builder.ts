import { createHash } from "node:crypto";
import type { Reservation } from "../chatbeds/types";

export interface CalendarEvent {
  summary: string; description: string; start: { date: string }; end: { date: string };
  extendedProperties: { private: { chatbedsReservationId: string; propertyId: string } };
}
export function buildEvent(r: Reservation): CalendarEvent {
  const guest = `${r.guest.first_name} ${r.guest.last_name}`.trim() || "Guest";
  return {
    summary: `${guest} — ${r.unit?.name || r.room_type?.name || "Unassigned room"}`,
    description: [`ChatBeds reservation: ${r.ref}`, `Status: ${r.status}`, `Stay: ${r.arrival} to ${r.departure}`, `Guests: ${r.adults} adult(s), ${r.children} child(ren)`, `Room type: ${r.room_type?.name || "Unassigned"}`, `Room: ${r.unit?.name || "Unassigned"}`, `Source: ${r.source}`].join("\n"),
    start: { date: r.arrival }, end: { date: r.departure },
    extendedProperties: { private: { chatbedsReservationId: r.id, propertyId: r.property_id } },
  };
}
export function contentHash(event: CalendarEvent) { return createHash("sha256").update(JSON.stringify(event)).digest("hex"); }
export function eventId(propertyId: string, reservationId: string, accountSub: string, calendarId: string, generation: number) {
  // Google accepts base32hex IDs. SHA-256 hex is a subset, with ample entropy.
  return createHash("sha256").update(JSON.stringify(["chatbeds-v1", propertyId, reservationId, accountSub, calendarId, generation])).digest("hex");
}
