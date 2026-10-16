import "server-only";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { CodeChallengeMethod } from "google-auth-library";
import { appAccessMode, appUrl, calendarId, env } from "../config";
import { encryptToken } from "../crypto/tokens";
import { db, checked } from "../db/client";
import { withIntegrationLock } from "../db/store";
import { AppError } from "../errors";
import { GOOGLE_SCOPES, oauthClient } from "../google/oauth";
import { withGoogleGrantLock } from "../google/grant-lock";
import { attachGoogleSetup, GOOGLE_ONBOARDING_COOKIE, GOOGLE_SETUP_TTL, sealGoogleSetup } from "../google/onboarding";
import { validOAuthState } from "../google/oauth-state";
import { hotelAuthClient } from "./hotel-client";
import { constantEquals, cookieOptions, createHotelSession, OAUTH_COOKIE, SESSION_COOKIE } from "./session";
import { selectedInstallationCookie } from "./installation";

export interface GoogleSignInState { intent: "signin"; action: "signin" | "install"; state: string; verifier: string; nonce: string; expires: number; }
export async function limitGoogleSignIn(request: Request) {
  const ip = (request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || "local").split(",")[0].trim().slice(0,100);
  const bucket = "google:" + createHmac("sha256",env("SESSION_SECRET")).update(ip).digest("hex");
  if (!checked(await db().rpc("allow_public_auth", { p_bucket: bucket, p_limit: 30, p_window_seconds: 600 })))
    throw new AppError("Too many sign-in attempts. Wait ten minutes and try again.",429);
}
export async function beginGoogleSignIn(action: "signin" | "install") {
  if (appAccessMode() !== "public") throw new AppError("Use the administrator sign-in for this deployment.", 404);
  const state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url"), client = oauthClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const expires = Date.now() + 600000;
  checked(await db().from("oauth_states").insert({ state_hash: createHash("sha256").update(state).digest("hex"), expires_at: new Date(expires).toISOString() }));
  const response = NextResponse.redirect(client.generateAuthUrl({ access_type: "offline", prompt: "select_account consent", scope: GOOGLE_SCOPES,
    state, nonce: createHash("sha256").update(nonce).digest("hex"), code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 }), 303);
  response.cookies.set(OAUTH_COOKIE, encryptToken(JSON.stringify({ intent: "signin", action, state, verifier: codeVerifier, nonce, expires } satisfies GoogleSignInState), "oauth-state"), cookieOptions(600));
  return response;
}
function loginRedirect(notice: string) {
  const url = appUrl(); url.pathname = "/login"; url.searchParams.set("notice", notice);
  url.searchParams.set("next", "/api/chatbeds/install");
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(OAUTH_COOKIE, "", cookieOptions(0));
  return response;
}
// One authorization code provides both verified identity and Calendar credentials.
// The ID token alone goes to Supabase; Google access/refresh tokens stay encrypted
// in Postgres and never become part of the browser's Supabase session cookie.
export async function finishGoogleSignIn(request: Request, stored: GoogleSignInState) {
  let notice = "google_signin_failed";
  try {
    const url = new URL(request.url);
    if (appAccessMode() !== "public" || !validOAuthState(url.searchParams.get("state"), stored.state, stored.expires) || typeof stored.nonce !== "string") return loginRedirect("google_state_invalid");
    if (!checked(await db().rpc("consume_oauth_state", { p_hash: createHash("sha256").update(stored.state).digest("hex") }))) return loginRedirect("google_state_invalid");
    if (url.searchParams.has("error")) return loginRedirect("google_denied");
    const code = url.searchParams.get("code");
    if (!code) return loginRedirect("google_signin_failed");
    return await withGoogleGrantLock(async () => {
      const client = oauthClient();
      const { tokens } = await client.getToken({ code, codeVerifier: stored.verifier });
      if (!tokens.id_token || !tokens.access_token || !tokens.expiry_date) throw new AppError("Google did not return complete credentials.", 502);
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env("GOOGLE_CLIENT_ID") });
      const identity = ticket.getPayload();
      const expectedNonce = createHash("sha256").update(stored.nonce).digest("hex");
      if (!identity?.sub || !identity.email || identity.email_verified !== true || !constantEquals(String(identity.nonce || ""), expectedNonce)) throw new AppError("Google identity could not be verified.", 401);
      if (!new Set((tokens.scope || "").split(" ")).has(GOOGLE_SCOPES[2])) return loginRedirect("google_permission_missing");
      const auth = await hotelAuthClient();
      const { data, error } = await auth.auth.signInWithIdToken({ provider: "google", token: tokens.id_token, nonce: stored.nonce });
      if (error || !data.user?.email_confirmed_at || !data.session) throw new AppError("Google sign-in could not be completed. Check the Google provider configuration.", 503);
      const userId = data.user.id;
      const members = checked(await db().from("integration_members").select("integration_id").eq("user_id", userId)) as { integration_id: string }[];
      const ids = members.map(row => row.integration_id);
      let refresh = tokens.refresh_token ? encryptToken(tokens.refresh_token, `${identity.sub}:refresh`) : null;
      if (!refresh && ids.length) {
        const prior = checked(await db().from("google_credentials").select("refresh_token_encrypted").in("integration_id", ids).eq("account_sub", identity.sub).limit(1).maybeSingle()) as { refresh_token_encrypted: string } | null;
        refresh = prior?.refresh_token_encrypted ?? null;
      }
      if (!refresh) { notice = "google_offline_missing"; throw new AppError("Google did not return offline access. Continue with Google again.", 409); }
      const setupId = randomUUID(), validUntil = Date.now() + GOOGLE_SETUP_TTL;
      checked(await db().from("google_onboarding").insert({ id: setupId, user_id: userId, account_sub: identity.sub, account_email: identity.email,
        calendar_id: calendarId(), access_token_encrypted: encryptToken(tokens.access_token!, `${identity.sub}:access`), refresh_token_encrypted: refresh,
        expires_at: tokens.expiry_date, scope: tokens.scope, valid_until: new Date(validUntil).toISOString() }));
      let targetId: string | undefined;
      if (stored.action !== "install" && ids.length) {
        const target = checked(await db().from("integration_settings").select("id").in("id", ids).not("property_id", "is", null).order("created_at").limit(1).maybeSingle()) as { id: string } | null;
        if (target) { await withIntegrationLock(() => attachGoogleSetup(userId, setupId, target.id), target.id); targetId = target.id; }
      }
      const destination = appUrl(); destination.pathname = targetId ? "/dashboard" : "/api/chatbeds/install";
      if (targetId) destination.searchParams.set("notice", "connected");
      const response = NextResponse.redirect(destination, 303);
      response.cookies.set(SESSION_COOKIE, createHotelSession(userId), cookieOptions(8 * 3600));
      response.cookies.set(OAUTH_COOKIE, "", cookieOptions(0));
      response.cookies.set(targetId ? selectedInstallationCookie(targetId) : { ...selectedInstallationCookie("sandbox"), value: "", maxAge: 0 });
      response.cookies.set(GOOGLE_ONBOARDING_COOKIE, targetId ? "" : sealGoogleSetup(setupId, userId, validUntil), cookieOptions(targetId ? 0 : GOOGLE_SETUP_TTL / 1000));
      return response;
    });
  } catch { return loginRedirect(notice); }
}
