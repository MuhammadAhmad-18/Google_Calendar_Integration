import { requireAdmin } from "@/lib/auth/session";
import { appAccessMode, chatbedsAuthMode, chatbedsOAuthReadiness, configurationReadiness, missingVariables } from "@/lib/config";
import { db, checked } from "@/lib/db/client";
import { getCredentials, getIntegration } from "@/lib/db/store";
import { visibleInstallations } from "@/lib/auth/tenancy";
import { selectedIntegrationId } from "@/lib/auth/installation";
import { errorResponse } from "@/lib/errors";
import { after } from "next/server";
import { safelyProcessJobs } from "@/lib/sync/worker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET() {
  try {
    await requireAdmin();
    const missing = missingVariables();
    const integrationId = await selectedIntegrationId();
    // Validate before creating any promises: a synchronous configuration error
    // inside a later array entry must not leave earlier promises unhandled.
    const database = db();
    const [integration, credentials, logs, jobs, pending, installations] = await Promise.all([
      getIntegration(integrationId), getCredentials(integrationId),
      database.from("sync_logs").select("id,source,event_type,reservation_id,reservation_ref,action,success,message,created_at").eq("integration_id", integrationId).order("created_at", { ascending: false }).limit(30),
      database.from("sync_jobs").select("id,kind,status,summary,error,date_from,date_to,created_at").eq("integration_id", integrationId).order("created_at", { ascending: false }).limit(15),
      database.from("sync_jobs").select("id").eq("integration_id", integrationId).or("status.eq.queued,status.eq.processing,and(status.eq.failed,kind.eq.webhook)").lte("next_attempt_at", new Date().toISOString()).limit(1),
      visibleInstallations(),
    ]);
    if (credentials && integration.chatbeds_status !== "disconnected" && checked(pending)?.length) after(() => safelyProcessJobs(integrationId));
    const oauthReady = chatbedsOAuthReadiness(missing);
    const publicMode = appAccessMode() === "public";
    return Response.json({ configuration: { publicMode, ready: missing.length === 0, authMode: chatbedsAuthMode(), chatbedsOAuthReady: oauthReady, ...configurationReadiness(missing), missing: publicMode ? [] : missing, webhookUrl: publicMode ? null : process.env.CHATBEDS_WEBHOOK_URL ?? null }, integration, installations,
      google: { connected: !!credentials, account_email: credentials?.account_email ?? null, calendar_id: credentials?.calendar_id ?? null }, logs: checked(logs), jobs: checked(jobs) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
