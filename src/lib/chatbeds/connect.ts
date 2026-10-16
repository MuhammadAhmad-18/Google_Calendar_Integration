import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieOptions, SESSION_COOKIE } from "../auth/session";
import { appAccessMode, appUrl, chatbedsAuthMode } from "../config";
import { currentGoogleSetup } from "../google/onboarding";
import { encryptToken } from "../crypto/tokens";
import { db, checked } from "../db/client";
import { AppError } from "../errors";
import { authorizationUrl } from "./oauth";
export const CHATBEDS_OAUTH_COOKIE = "chatbeds_app_state";
export async function beginChatBedsConnect() {
  if (chatbedsAuthMode() !== "oauth") throw new AppError("Set CHATBEDS_AUTH_MODE=oauth to connect a ChatBeds app.", 409);
  const googleSetupId = await currentGoogleSetup();
  if (appAccessMode() === "public" && !googleSetupId) {
    const login = appUrl(); login.pathname = "/login"; login.searchParams.set("next", "/api/chatbeds/install"); login.searchParams.set("connect", "1");
    return NextResponse.redirect(login, 303);
  }
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
  const url = authorizationUrl(state, verifier);
  const expires = Date.now() + 600000;
  checked(await db().from("oauth_states").insert({ state_hash: createHash("sha256").update(state).digest("hex"), expires_at: new Date(expires).toISOString() }));
  const session = (await cookies()).get(SESSION_COOKIE)!.value;
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(CHATBEDS_OAUTH_COOKIE, encryptToken(JSON.stringify({ state, verifier, expires,
    sessionHash: createHash("sha256").update(session).digest("hex"), ...(googleSetupId ? { googleSetupId } : {}) }), "chatbeds-oauth-state"), cookieOptions(600));
  return response;
}
