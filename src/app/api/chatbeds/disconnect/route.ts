import { requireAdmin, requireOrigin } from "@/lib/auth/session";
import { selectedIntegrationId } from "@/lib/auth/installation";
import { getChatBedsCredentials, withChatBedsRefreshLock, chatbedsTokenContext } from "@/lib/chatbeds/token-store";
import { revokeChatBedsToken } from "@/lib/chatbeds/oauth";
import { decryptToken } from "@/lib/crypto/tokens";
import { db, checked } from "@/lib/db/client";
import { getIntegration, logSync, updateIntegration, withIntegrationLock } from "@/lib/db/store";
import { AppError, errorResponse } from "@/lib/errors";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await requireAdmin(); requireOrigin(request);
    const id = await selectedIntegrationId();
    return await withIntegrationLock(async () => {
      if ((await getIntegration(id)).auth_mode !== "oauth") throw new AppError("Private API keys are managed in ChatBeds Settings. This disconnect action is for app installations.", 409);
      let revoked = true;
      const credentials = await getChatBedsCredentials(id);
      if (credentials) await withChatBedsRefreshLock(id, async () => {
        if (credentials.refresh_started) revoked = false;
        // Never revoke a potentially consumed refresh token; use the access token.
        try { await revokeChatBedsToken(decryptToken(credentials.access_token_encrypted, chatbedsTokenContext(credentials.installation_id, "access"))); }
        catch { revoked = false; }
        checked(await db().from("chatbeds_credentials").delete().eq("integration_id", id));
      });
      await updateIntegration({ chatbeds_status: "disconnected", chatbeds_error: revoked ? null : "Local tokens removed. Disconnect the app on ChatBeds Apps to confirm revocation." }, id);
      await logSync({ source: "chatbeds_oauth", action: "disconnect", success: true, message: revoked ? "ChatBeds tokens removed and revoked. Existing Google events and mappings retained." : "ChatBeds tokens removed locally; revocation was not confirmed. Disconnect in ChatBeds Apps." }, id);
      return Response.json({ ok: true, revoked });
    }, id);
  } catch (error) { return errorResponse(error); }
}
