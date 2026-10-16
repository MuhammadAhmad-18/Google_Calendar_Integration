import { after } from "next/server";
import { verifySignature } from "@/lib/chatbeds/webhook";
import { env } from "@/lib/config";
import { db, checked } from "@/lib/db/client";
import { getIntegration, integrationColumns } from "@/lib/db/store";
import { chatbedsAuthMode } from "@/lib/config";
import { webhookEnvelope } from "@/lib/chatbeds/types";
import type { Integration } from "@/lib/db/types";
import { AppError, errorResponse } from "@/lib/errors";
import { acceptDelivery, parseDelivery } from "@/lib/sync/webhook-delivery";
import { safelyProcessJobs } from "@/lib/sync/worker";
import { withRequestBudget } from "@/lib/budget";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > 256000) throw new AppError("Webhook payload is too large.", 413);
    if (!verifySignature(raw, request.headers.get("ChatBeds-Signature"), env("CHATBEDS_WEBHOOK_SECRET"))) throw new AppError("Webhook signature is invalid.", 400);
    const result = await withRequestBudget(7000, async () => {
      let value: unknown;
      try { value = JSON.parse(raw.toString("utf8")); } catch { throw new AppError("Webhook JSON is invalid.", 400); }
      const envelope = webhookEnvelope.safeParse(value);
      if (!envelope.success) throw new AppError("Webhook payload is invalid.", 400);
      const integration: Integration | null = chatbedsAuthMode() === "oauth"
        ? checked(await db().from("integration_settings").select(integrationColumns).eq("property_id", envelope.data.property_id).eq("auth_mode", "oauth").maybeSingle())
        : await getIntegration();
      if (!integration?.property_id) {
        // A signed app-wide webhook can arrive for a removed/unregistered property.
        // Validate headers and event shape, then safely acknowledge without syncing.
        if (chatbedsAuthMode() === "oauth") { parseDelivery(value, request.headers.get("ChatBeds-Delivery"), envelope.data.property_id, request.headers.get("ChatBeds-Event")); return { ignored: true, integrationId: null, disconnected: false }; }
        throw new AppError("Test the ChatBeds connection before configuring webhooks.", 503);
      }
      const delivery = parseDelivery(value, request.headers.get("ChatBeds-Delivery"), integration.property_id, request.headers.get("ChatBeds-Event"));
      const accepted = await acceptDelivery(delivery, async d => checked(await db().rpc("enqueue_installation_webhook", { p_integration_id: integration.id, p_delivery_id: d.deliveryId, p_event_type: d.eventType, p_property_id: d.propertyId, p_reservation_id: d.reservationId })) as boolean);
      return { ...accepted, integrationId: integration.id, disconnected: integration.chatbeds_status === "disconnected" };
    });
    // Schedule outside the short receipt budget; processing has its own budget.
    if (!result.ignored && !result.disconnected && result.integrationId) after(() => safelyProcessJobs(result.integrationId!));
    return new Response(null, { status: 204 });
  } catch (error) { return errorResponse(error); }
}
