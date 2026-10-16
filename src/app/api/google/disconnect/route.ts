import { requireAdmin, requireOrigin } from "@/lib/auth/session";
import { decryptToken } from "@/lib/crypto/tokens";
import { db, checked } from "@/lib/db/client";
import { getCredentials, logSync, updateIntegration, withIntegrationLock } from "@/lib/db/store";
import { errorResponse } from "@/lib/errors";
import { revokeGoogleToken } from "@/lib/google/oauth";
import { selectedIntegrationId } from "@/lib/auth/installation";
import { withGoogleGrantLock } from "@/lib/google/grant-lock";
import { appAccessMode } from "@/lib/config";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await requireAdmin(); requireOrigin(request);
    const id = await selectedIntegrationId();
    return await withIntegrationLock(() => withGoogleGrantLock(async () => {
      const credentials = await getCredentials(id);
      let revoked = true;
      if (credentials) {
        try { await revokeGoogleToken(decryptToken(credentials.refresh_token_encrypted, `${credentials.account_sub}:refresh`)); }
        catch { revoked = false; }
      }
      // Google revokes the user's entire grant for this OAuth app. Remove every
      // saved copy for that account so other properties cannot keep refreshing it.
      const removed = credentials
        ? checked(await db().from("google_credentials").delete().eq("account_sub", credentials.account_sub).select("integration_id")) as { integration_id: string }[]
        : [{ integration_id: id }];
      if (credentials && appAccessMode() === "public") checked(await db().from("google_onboarding").delete().eq("account_sub", credentials.account_sub));
      for (const row of removed) {
        await updateIntegration({ google_calendar_id: null }, row.integration_id);
        await logSync({ source: "oauth", action: "disconnect", success: true, message: revoked ? "Google app grant revoked for this account across its properties. Existing calendar events retained." : "Google credentials removed for this account. Revocation failed; remove this app in Google account permissions." }, row.integration_id);
      }
      return Response.json({ ok: true });
    }), id);
  } catch (error) { return errorResponse(error); }
}
