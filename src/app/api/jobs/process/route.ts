import { requireAdmin, requireOrigin, constantEquals } from "@/lib/auth/session";
import { appAccessMode, env, publicBranding } from "@/lib/config";
import { db, checked } from "@/lib/db/client";
import { AppError, errorResponse } from "@/lib/errors";
import { processJobs, processAllJobs, retryFailedJobs } from "@/lib/sync/worker";
import { selectedIntegrationId } from "@/lib/auth/installation";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    if (!constantEquals(request.headers.get("authorization") || "", `Bearer ${env("CRON_SECRET")}`)) throw new AppError("Unauthorized.", 401);
    const result = await processAllJobs();
    if (appAccessMode() === "public") checked(await db().rpc("cleanup_integration_history", { p_days: publicBranding().retentionDays }));
    return Response.json(result);
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    await requireAdmin(); requireOrigin(request);
    const id = await selectedIntegrationId();
    await retryFailedJobs(id);
    return Response.json(await processJobs(id));
  } catch (error) { return errorResponse(error); }
}
