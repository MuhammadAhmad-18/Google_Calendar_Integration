import { NextResponse } from "next/server";
import { z } from "zod";
import { constantEquals, cookieOptions, createSession, requireOrigin, SESSION_COOKIE } from "@/lib/auth/session";
import { appAccessMode, env } from "@/lib/config";
import { db, checked } from "@/lib/db/client";
import { AppError, errorResponse } from "@/lib/errors";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    if (appAccessMode() === "public") throw new AppError("Use your personal hotel sign-in.", 403);
    const password = env("ADMIN_PASSWORD");
    if (password.length < 24) throw new AppError("ADMIN_PASSWORD must contain at least 24 random characters.", 503);
    const allowed = checked(await db().rpc("allow_admin_login", { p_bucket: "sandbox-admin" }));
    if (!allowed) throw new AppError("Too many sign-in attempts. Wait 15 minutes before trying again.", 429);
    const body = z.object({ password: z.string().max(256) }).safeParse(await request.json());
    if (!body.success || !constantEquals(body.data.password, password)) throw new AppError("Admin password is incorrect.", 401);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, createSession(), cookieOptions(8 * 60 * 60));
    return response;
  } catch (error) { return errorResponse(error); }
}
