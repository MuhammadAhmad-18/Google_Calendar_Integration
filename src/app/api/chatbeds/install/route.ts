import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth/session";
import { beginChatBedsConnect } from "@/lib/chatbeds/connect";
import { appAccessMode, appUrl } from "@/lib/config";
import { errorResponse } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    if (!await isAdmin()) {
      const url = appUrl();
      if (appAccessMode() === "public") { url.pathname = "/login"; url.searchParams.set("next", "/api/chatbeds/install"); }
      else { url.searchParams.set("notice", "chatbeds_sign_in"); url.searchParams.set("install", "chatbeds"); }
      return NextResponse.redirect(url, 303);
    }
    return await beginChatBedsConnect();
  } catch (error) { return errorResponse(error); }
}
