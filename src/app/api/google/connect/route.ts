import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { CodeChallengeMethod } from "google-auth-library";
import { cookieOptions, OAUTH_COOKIE, requireAdmin, requireOrigin, SESSION_COOKIE } from "@/lib/auth/session";
import { encryptToken } from "@/lib/crypto/tokens";
import { db, checked } from "@/lib/db/client";
import { getIntegration } from "@/lib/db/store";
import { selectedIntegrationId } from "@/lib/auth/installation";
import { AppError, errorResponse } from "@/lib/errors";
import { GOOGLE_SCOPES, oauthClient } from "@/lib/google/oauth";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await requireAdmin(); requireOrigin(request);
    const integrationId = await selectedIntegrationId();
    if (!(await getIntegration(integrationId)).property_id) throw new AppError("Connect or test ChatBeds first.", 409);
    const state = randomBytes(32).toString("base64url");
    const client = oauthClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const expires = Date.now() + 10 * 60 * 1000;
    checked(await db().from("oauth_states").insert({ state_hash: createHash("sha256").update(state).digest("hex"), expires_at: new Date(expires).toISOString() }));
    const session = (await cookies()).get(SESSION_COOKIE)!.value;
    const response = NextResponse.redirect(client.generateAuthUrl({
      access_type: "offline", prompt: "consent", scope: GOOGLE_SCOPES, state,
      code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
    }), 303);
    response.cookies.set(OAUTH_COOKIE, encryptToken(JSON.stringify({ state, verifier: codeVerifier, expires, integrationId, sessionHash: createHash("sha256").update(session).digest("hex") }), "oauth-state"), cookieOptions(600));
    return response;
  } catch (error) { return errorResponse(error); }
}
