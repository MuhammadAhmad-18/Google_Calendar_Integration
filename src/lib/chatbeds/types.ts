import { z } from "zod";

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid date");
const named = z.object({ id: z.uuid(), name: z.string() }).nullable();
// Intentionally strip contact/payment details from the data used by synchronization.
export const reservationSchema = z.object({
  id: z.uuid(), ref: z.string(), property_id: z.uuid(),
  status: z.enum(["pending", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"]),
  source: z.string(), arrival: dateSchema, departure: dateSchema,
  adults: z.number().int().nonnegative(), children: z.number().int().nonnegative(),
  guest: z.object({ first_name: z.string(), last_name: z.string() }),
  room_type: named, unit: named,
  updated_at: z.iso.datetime({ offset: true }),
}).refine(r => r.departure > r.arrival, "Departure must be after arrival");
export type Reservation = z.infer<typeof reservationSchema>;
export const identitySchema = z.object({ property: z.object({ id: z.uuid(), name: z.string() }) });
export const supportedEvents = ["reservation.created", "reservation.modified", "reservation.cancelled"] as const;
export const webhookEnvelope = z.object({ id: z.uuid(), type: z.string(), created_at: z.iso.datetime({ offset: true }), property_id: z.uuid(), data: z.unknown() });
