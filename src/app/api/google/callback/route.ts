import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { after, NextResponse } from "next/server";
import { constantEquals, cookieOptions, OAUTH_COOKIE, requireAdmin, SESSION_COOKIE } from "@/lib/auth/session";
import { appAccessMode, dashboardUrl, calendarId, env } from "@/lib/config";
import { finishGoogleSignIn, type GoogleSignInState } from "@/lib/auth/google-signin";
import { assertInstallationAccess } from "@/lib/auth/tenancy";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { db, checked } from "@/lib/db/client";
import { getCredentials, logSync, saveCredentials, updateIntegration, withIntegrationLock } from "@/lib/db/store";
import { AppError, safeError } from "@/lib/errors";
import { GOOGLE_SCOPES, oauthClient } from "@/lib/google/oauth";
import { validOAuthState } from "@/lib/google/oauth-state";
import { selectedInstallationCookie } from "@/lib/auth/installation";
import { withGoogleGrantLock } from "@/lib/google/grant-lock";
import { safelyProcessJobs } from "@/lib/sync/worker";
export const runtime = "nodejs";
export const maxDuration = 60;

function redirect(notice: string, integrationId?: string) {
  const url = dashboardUrl(); url.searchParams.set("notice", notice);
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(OAUTH_COOKIE, "", cookieOptions(0));
  if (integrationId) response.cookies.set(selectedInstallationCookie(integrationId));
  return response;
}
export async function GET(request: Request) {
  if (appAccessMode() === "public") {
    const value = (await cookies()).get(OAUTH_COOKIE)?.value;
    if (value) {
      try {
        const state = JSON.parse(decryptToken(value, "oauth-state"));
        if (state.intent === "signin") return finishGoogleSignIn(request, state as GoogleSignInState);
      } catch { /* Existing account-connection flow below rejects invalid state. */ }
    }
  }
  let stateChecked = false;
  let failureNotice = "oauth_failed";
  let integrationId = "sandbox";
  let hasAccess = false;
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const jar = await cookies();
    const sealed = jar.get(OAUTH_COOKIE)?.value;
    if (!sealed) return redirect("oauth_state_invalid");
    const stored = JSON.parse(decryptToken(sealed, "oauth-state")) as { state: string; verifier: string; expires: number; sessionHash: string; integrationId?: string };
    const sessionHash = createHash("sha256").update(jar.get(SESSION_COOKIE)!.value).digest("hex");
    if (!validOAuthState(url.searchParams.get("state"), stored.state, stored.expires) || !constantEquals(sessionHash, stored.sessionHash)) return redirect("oauth_state_invalid");
    const consumed = checked(await db().rpc("consume_oauth_state", { p_hash: createHash("sha256").update(stored.state).digest("hex") }));
    if (!consumed) return redirect("oauth_state_invalid");
    stateChecked = true;
    integrationId = stored.integrationId ?? "sandbox";
    await assertInstallationAccess(integrationId);
    hasAccess = true;
    if (url.searchParams.has("error")) return redirect("oauth_denied");
    const code = url.searchParams.get("code");
    if (!code) return redirect("oauth_failed");
    await withIntegrationLock(() => withGoogleGrantLock(async () => {
      const client = oauthClient();
      const { tokens } = await client.getToken({ code, codeVerifier: stored.verifier });
      if (!tokens.id_token || !tokens.access_token || !tokens.expiry_date) throw new AppError("Google did not return complete credentials. Connect again.", 502);
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env("GOOGLE_CLIENT_ID") });
      const identity = ticket.getPayload();
      if (!identity?.sub) throw new AppError("Google account identity could not be verified.", 502);
      const scopes = new Set((tokens.scope || "").split(" "));
      if (!scopes.has(GOOGLE_SCOPES[2])) {
        failureNotice = "oauth_calendar_permission_missing";
        throw new AppError("Google Calendar event permission was not granted. Connect again and select permission to view and edit events on your calendars.", 403);
      }
      const previous = await getCredentials(integrationId);
      const sameAccount = previous?.account_sub === identity.sub;
      const refresh = tokens.refresh_token ? encryptToken(tokens.refresh_token, `${identity.sub}:refresh`) : sameAccount ? previous!.refresh_token_encrypted : null;
      if (!refresh) throw new AppError("Google did not return a refresh token. Remove this app from your Google account permissions and reconnect.", 502);
      await saveCredentials({ integration_id: integrationId, account_sub: identity.sub, account_email: identity.email ?? null, calendar_id: calendarId(), access_token_encrypted: encryptToken(tokens.access_token, `${identity.sub}:access`), refresh_token_encrypted: refresh, expires_at: tokens.expiry_date });
      await updateIntegration({ google_calendar_id: calendarId() }, integrationId);
      await logSync({ source: "oauth", action: "connect", success: true, message: "Google Calendar connected." }, integrationId);
    }), integrationId);
    after(() => safelyProcessJobs(integrationId));
    return redirect("connected", integrationId);
  } catch (error) {
    if (stateChecked && hasAccess) {
      try { await logSync({ source: "oauth", action: "connect", success: false, message: safeError(error) }, integrationId); } catch { /* No provider response bodies are exposed. */ }
    }
    return redirect(stateChecked ? failureNotice : "oauth_state_invalid", stateChecked && hasAccess ? integrationId : undefined);
  }
}
