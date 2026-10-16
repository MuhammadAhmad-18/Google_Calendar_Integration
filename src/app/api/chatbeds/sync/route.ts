import { after } from "next/server";
import { requireAdmin, requireOrigin } from "@/lib/auth/session";
import { db, checked } from "@/lib/db/client";
import { getCredentials, getIntegration } from "@/lib/db/store";
import { AppError, errorResponse } from "@/lib/errors";
import { dateRange, initialCursor } from "@/lib/sync/initial-sync";
import { safelyProcessJobs } from "@/lib/sync/worker";
import { selectedIntegrationId } from "@/lib/auth/installation";
import { credentialProvider } from "@/lib/chatbeds/credentials";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await requireAdmin(); requireOrigin(request);
    const { from, to } = dateRange(await request.json());
    const id = await selectedIntegrationId(), integration = await getIntegration(id);
    if (!integration.property_id) throw new AppError("Connect or test ChatBeds first.", 409);
    credentialProvider(integration);
    if (!await getCredentials(id)) throw new AppError("Connect Google Calendar first.", 409);
    const job = checked(await db().from("sync_jobs").insert({ integration_id: id, kind: "manual", date_from: from, date_to: to, cursor: initialCursor(from) }).select("id").single());
    if (!job) throw new AppError("The sync job could not be created.", 503);
    after(() => safelyProcessJobs(id));
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
