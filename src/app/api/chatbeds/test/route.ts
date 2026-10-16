import { requireAdmin, requireOrigin } from "@/lib/auth/session";
import { ChatBedsClient } from "@/lib/chatbeds/client";
import { getIntegration, updateIntegration, withIntegrationLock } from "@/lib/db/store";
import { AppError, errorResponse, safeError } from "@/lib/errors";
import { selectedIntegrationId } from "@/lib/auth/installation";
import { credentialProvider } from "@/lib/chatbeds/credentials";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await requireAdmin(); requireOrigin(request);
    const id = await selectedIntegrationId();
    return await withIntegrationLock(async () => {
      try {
        const existing = await getIntegration(id);
        const { property } = await new ChatBedsClient(credentialProvider(existing), id).me();
        if (existing.property_id && existing.property_id !== property.id) throw new AppError("This installation is bound to a different property. Connect the other property as a separate app installation.", 409);
        await updateIntegration({ property_id: property.id, property_name: property.name, chatbeds_status: "connected", chatbeds_error: null }, id);
        return Response.json({ property });
      } catch (error) {
        const existing = await getIntegration(id);
        await updateIntegration({ chatbeds_status: existing.chatbeds_status === "disconnected" ? "disconnected" : "error", chatbeds_error: safeError(error) }, id);
        throw error;
      }
    }, id);
  } catch (error) { return errorResponse(error); }
}
