import { NextResponse } from "next/server";
import { cookieOptions, OAUTH_COOKIE, requireOrigin, SESSION_COOKIE } from "@/lib/auth/session";
import { errorResponse } from "@/lib/errors";
import { CHATBEDS_OAUTH_COOKIE } from "@/lib/chatbeds/connect";
import { INSTALLATION_COOKIE } from "@/lib/auth/installation";
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
    response.cookies.set(OAUTH_COOKIE, "", cookieOptions(0));
    response.cookies.set(CHATBEDS_OAUTH_COOKIE, "", cookieOptions(0));
    response.cookies.set(INSTALLATION_COOKIE, "", cookieOptions(0));
    return response;
  } catch (error) { return errorResponse(error); }
}
