import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appAccessMode } from "@/lib/config";
import { hotelAuthClient } from "@/lib/auth/hotel-client";
import { cookieOptions, OAUTH_COOKIE, requireOrigin, SESSION_COOKIE } from "@/lib/auth/session";
import { CHATBEDS_OAUTH_COOKIE } from "@/lib/chatbeds/connect";
import { INSTALLATION_COOKIE } from "@/lib/auth/installation";
import { GOOGLE_ONBOARDING_COOKIE } from "@/lib/google/onboarding";
import { errorResponse } from "@/lib/errors";
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    if (appAccessMode() === "public") { try { await (await hotelAuthClient()).auth.signOut({ scope: "local" }); } catch { /* Clear local cookies even during an Auth outage. */ } }
    const response = NextResponse.json({ ok: true });
    const jar = await cookies();
    for (const name of [SESSION_COOKIE, OAUTH_COOKIE, CHATBEDS_OAUTH_COOKIE, INSTALLATION_COOKIE, GOOGLE_ONBOARDING_COOKIE, ...jar.getAll().filter(row => row.name.startsWith("sb-")).map(row => row.name)]) response.cookies.set(name, "", cookieOptions(0));
    return response;
  } catch (error) { return errorResponse(error); }
}
