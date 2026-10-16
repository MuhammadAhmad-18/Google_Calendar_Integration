import type { Reservation } from "../chatbeds/types";
import { reservationSchema, supportedEvents, webhookEnvelope } from "../chatbeds/types";
import { AppError } from "../errors";

export interface AcceptedDelivery { deliveryId: string; eventType: string; propertyId: string; reservationId: string | null; }
export function parseDelivery(value: unknown, deliveryHeader: string | null, expectedProperty: string, eventHeader: string | null): AcceptedDelivery {
  const parsed = webhookEnvelope.safeParse(value);
  if (!parsed.success) throw new AppError("Webhook payload is invalid.", 400);
  const event = parsed.data;
  if (event.id !== deliveryHeader || event.type !== eventHeader) throw new AppError("Webhook delivery/event headers do not match the signed body.", 400);
  if (event.property_id !== expectedProperty) throw new AppError("Webhook belongs to another property.", 403);
  let reservation: Reservation | null = null;
  if ((supportedEvents as readonly string[]).includes(event.type)) {
    const data = event.data as { reservation?: unknown } | null;
    const result = reservationSchema.safeParse(data?.reservation);
    if (!result.success || result.data.property_id !== event.property_id) throw new AppError("Webhook reservation is invalid.", 400);
    reservation = result.data;
  }
  return { deliveryId: event.id, eventType: event.type, propertyId: event.property_id, reservationId: reservation?.id ?? null };
}
export async function acceptDelivery(delivery: AcceptedDelivery, enqueue: (delivery: AcceptedDelivery) => Promise<boolean>) {
  const inserted = await enqueue(delivery);
  return { duplicate: !inserted, ignored: delivery.reservationId === null };
}
