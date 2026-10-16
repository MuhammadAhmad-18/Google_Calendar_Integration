import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, requireOrigin } from "@/lib/auth/session";
import { selectedInstallationCookie } from "@/lib/auth/installation";
import { getIntegration } from "@/lib/db/store";
import { errorResponse } from "@/lib/errors";
import { assertInstallationAccess } from "@/lib/auth/tenancy";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await requireAdmin(); requireOrigin(request);
    const { integrationId } = z.object({ integrationId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/) }).parse(await request.json());
    await assertInstallationAccess(integrationId);
    await getIntegration(integrationId);
    const response = NextResponse.json({ ok: true }); response.cookies.set(selectedInstallationCookie(integrationId)); return response;
  } catch (error) { return errorResponse(error); }
}
