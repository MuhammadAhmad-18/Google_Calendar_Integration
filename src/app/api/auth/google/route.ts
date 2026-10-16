import { NextResponse } from "next/server";
import { appUrl } from "@/lib/config";
import { requireOrigin } from "@/lib/auth/session";
import { beginGoogleSignIn, limitGoogleSignIn } from "@/lib/auth/google-signin";
import { AppError, errorResponse } from "@/lib/errors";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    await limitGoogleSignIn(request);
    const body = await request.formData();
    return await beginGoogleSignIn(body.get("intent") === "install" ? "install" : "signin");
  } catch (error) {
    if (error instanceof AppError && [403,429].includes(error.status)) return errorResponse(error);
    const url = appUrl(); url.pathname = "/login"; url.searchParams.set("notice", "google_signin_failed");
    url.searchParams.set("next", "/api/chatbeds/install");
    return NextResponse.redirect(url, 303);
  }
}
