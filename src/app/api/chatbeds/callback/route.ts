import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { after, NextResponse } from "next/server";
import { constantEquals, cookieOptions, requireAdmin, SESSION_COOKIE } from "@/lib/auth/session";
import { selectedInstallationCookie } from "@/lib/auth/installation";
import { CHATBEDS_OAUTH_COOKIE } from "@/lib/chatbeds/connect";
import { ChatBedsClient } from "@/lib/chatbeds/client";
import { OAuthCredentialProvider } from "@/lib/chatbeds/credentials";
import { exchangeChatBedsCode } from "@/lib/chatbeds/oauth";
import { installChatBeds } from "@/lib/chatbeds/token-store";
import { appAccessMode, dashboardUrl } from "@/lib/config";
import { GOOGLE_ONBOARDING_COOKIE } from "@/lib/google/onboarding";
import { withGoogleGrantLock } from "@/lib/google/grant-lock";
import { decryptToken } from "@/lib/crypto/tokens";
import { db, checked } from "@/lib/db/client";
import { logSync, updateIntegration, withIntegrationLock } from "@/lib/db/store";
import { AppError, safeError } from "@/lib/errors";
import { validOAuthState } from "@/lib/google/oauth-state";
import { safelyProcessJobs } from "@/lib/sync/worker";
export const runtime = "nodejs";
export const maxDuration = 60;
function redirect(notice: string, integrationId?: string) {
  const url = dashboardUrl(); url.searchParams.set("notice", notice);
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(CHATBEDS_OAUTH_COOKIE, "", cookieOptions(0));
  if (integrationId) { response.cookies.set(selectedInstallationCookie(integrationId)); response.cookies.set(GOOGLE_ONBOARDING_COOKIE, "", cookieOptions(0)); }
  return response;
}
export async function GET(request: Request) {
  let integrationId = "sandbox", stateChecked = false, installed = false;
  try {
    await requireAdmin();
    const jar = await cookies(), url = new URL(request.url);
    const sealed = jar.get(CHATBEDS_OAUTH_COOKIE)?.value;
    if (!sealed) return redirect("chatbeds_state_invalid");
    const stored = JSON.parse(decryptToken(sealed, "chatbeds-oauth-state")) as { state: string; verifier: string; expires: number; sessionHash: string; googleSetupId?: string };
    if (!validOAuthState(url.searchParams.get("state"), stored.state, stored.expires) ||
      !constantEquals(stored.sessionHash, createHash("sha256").update(jar.get(SESSION_COOKIE)!.value).digest("hex"))) return redirect("chatbeds_state_invalid");
    if (!checked(await db().rpc("consume_oauth_state", { p_hash: createHash("sha256").update(stored.state).digest("hex") }))) return redirect("chatbeds_state_invalid");
    stateChecked = true;
    if (url.searchParams.has("error")) return redirect("chatbeds_denied");
    const code = url.searchParams.get("code");
    if (!code) return redirect("chatbeds_oauth_failed");
    if (appAccessMode() === "public" && !stored.googleSetupId) return redirect("chatbeds_oauth_failed");
    const tokens = await exchangeChatBedsCode(code, stored.verifier);
    integrationId = stored.googleSetupId && appAccessMode() === "public"
      ? await withGoogleGrantLock(() => installChatBeds(tokens, stored.googleSetupId))
      : await installChatBeds(tokens); // Both providers persist atomically before API work.
    installed = true;
    await withIntegrationLock(async () => {
      const { property } = await new ChatBedsClient(new OAuthCredentialProvider(integrationId), integrationId).me();
      if (property.id !== tokens.property_id) throw new AppError("ChatBeds identity did not match the authorized property.", 502);
      await updateIntegration({ property_name: property.name, chatbeds_status: "connected", chatbeds_error: null }, integrationId);
      await logSync({ source: "chatbeds_oauth", action: "connect", success: true, message: "ChatBeds app connected with reservations:read permission." }, integrationId);
    }, integrationId);
    after(() => safelyProcessJobs(integrationId));
    return redirect("chatbeds_connected", integrationId);
  } catch (error) {
    if (stateChecked && (installed || appAccessMode() === "private")) {
      try {
        if (installed) await updateIntegration({ chatbeds_status: "error", chatbeds_error: safeError(error) }, integrationId);
        await logSync({ source: "chatbeds_oauth", action: "connect", success: false, message: safeError(error) }, integrationId);
      } catch { /* Never expose provider responses or credentials. */ }
    }
    return redirect(stateChecked ? "chatbeds_oauth_failed" : "chatbeds_state_invalid", installed ? integrationId : undefined);
  }
}
