import "server-only";
import { ChatBedsClient } from "../chatbeds/client";
import { db, checked } from "../db/client";
import { getIntegration, logSync, installationMappingStore, saveJob, withIntegrationLock } from "../db/store";
import { credentialProvider } from "../chatbeds/credentials";
import { ChatBedsRetryError } from "../chatbeds/rate-limit";
import { type ManualCursor, type SyncJob } from "../db/types";
import { AppError, safeError } from "../errors";
import { googleCalendar } from "../google/calendar";
import { initialCursor, nextDate, searchStatuses } from "./initial-sync";
import { syncReservation, type SyncAction } from "./sync-reservation";
import { withRequestBudget } from "../budget";

const countKey: Record<SyncAction, "created" | "updated" | "deleted" | "skipped"> = { create: "created", update: "updated", delete: "deleted", skip: "skipped" };

export async function processJobs(integrationId = "sandbox", budgetMs = 40000): Promise<{ processed: number }> {
  return withIntegrationLock(() => withRequestBudget(budgetMs, async () => {
    // Stop starting work well before Vercel's 60s invocation deadline.
    const deadline = Date.now() + Math.max(1000, budgetMs - 5000);
    const integration = await getIntegration(integrationId);
    if (!integration.property_id) throw new AppError("Test the ChatBeds connection first.", 409);
    checked(await db().from("integration_settings").update({ last_worker_at: new Date().toISOString() }).eq("id", integrationId));
    const { gateway, credentials } = await googleCalendar(integrationId);
    const client = new ChatBedsClient(credentialProvider(integration), integrationId);
    const maps = installationMappingStore(integrationId);
    let processed = 0;
    while (Date.now() < deadline) {
      const jobs = checked(await db().from("sync_jobs").select("*")
        .eq("integration_id", integrationId)
        .or("status.eq.queued,status.eq.processing,and(status.eq.failed,kind.eq.webhook)")
        .lte("next_attempt_at", new Date().toISOString()).order("kind", { ascending: false }).order("created_at").limit(1)) as SyncJob[];
      const job = jobs[0];
      if (!job) break;
      job.status = "processing";
      job.error = null;
      await saveJob(job);
      const sync = async (id: string) => {
        const reservation = await client.reservation(id);
        if (reservation.property_id !== integration.property_id) throw new AppError("Reservation belongs to another property.", 403);
        const result = await syncReservation(reservation, { maps, calendar: gateway, accountSub: credentials.account_sub, calendarId: credentials.calendar_id, integrationId });
        await logSync({ source: job.kind, event_type: job.event_type, reservation_id: id, reservation_ref: reservation.ref, google_event_id: result.eventId, action: result.action, success: true, message: result.message }, integrationId);
        job.summary[countKey[result.action]]++;
      };
      try {
        if (job.kind === "webhook") {
          await sync(job.reservation_id!);
          job.status = "completed";
          // Mark the delivery before completing the job; retry after a partial DB
          // failure is harmless because calendar mutations are idempotent.
          checked(await db().from("webhook_deliveries").update({ status: "processed", processed_at: new Date().toISOString(), error: null }).eq("delivery_id", job.delivery_id!));
          await saveJob(job);
          processed++;
        } else {
          const cursor: ManualCursor = job.cursor.date ? job.cursor as ManualCursor : initialCursor(job.date_from!);
          job.cursor = cursor;
          if (!cursor.searched) {
            const status = cursor.searches[cursor.searchIndex];
            const reservations = await client.search(integration.property_id, cursor.date, status || undefined);
            for (const r of reservations) if (!cursor.ids.includes(r.id) && !cursor.seenIds.includes(r.id)) cursor.ids.push(r.id);
            if (reservations.length === 100) {
              if (!status) {
                cursor.searches.push(...searchStatuses);
                cursor.warnings.push(`${cursor.date}: search reached 100; querying documented statuses. Pending bookings may be incomplete.`);
              } else cursor.warnings.push(`${cursor.date} (${status}): 100 results; API has no pagination, so more bookings may exist.`);
            }
            cursor.searchIndex++;
            cursor.searched = cursor.searchIndex >= cursor.searches.length;
          } else if (cursor.index < cursor.ids.length) {
            const id = cursor.ids[cursor.index];
            try { await sync(id); }
            catch (error) {
              if (error instanceof ChatBedsRetryError || (error instanceof AppError && error.status === 409)) throw error;
              job.summary.failed++;
              await logSync({ source: "manual", reservation_id: id, action: "error", success: false, message: safeError(error) }, integrationId);
            }
            cursor.index++;
            cursor.seenIds.push(id);
          } else {
            const date = nextDate(cursor.date);
            if (date > job.date_to!) {
              job.status = job.summary.failed ? "failed" : "completed";
              job.error = [...cursor.warnings, ...(job.summary.failed ? ["Some reservations failed. Retry this range after resolving the error."] : [])].join(" ") || null;
              processed++;
            } else job.cursor = initialCursor(date, cursor.warnings, cursor.seenIds);
          }
          await saveJob(job);
        }
      } catch (error) {
        job.status = error instanceof ChatBedsRetryError || (error instanceof AppError && error.status === 409) ? "queued" : "failed";
        job.attempts++;
        job.error = safeError(error);
        job.next_attempt_at = new Date(Date.now() + (error instanceof ChatBedsRetryError ? error.retryAfter : Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7))) * 1000).toISOString();
        await saveJob(job);
        if (job.delivery_id) checked(await db().from("webhook_deliveries").update({ status: "failed", error: job.error }).eq("delivery_id", job.delivery_id));
        await logSync({ source: job.kind, event_type: job.event_type, reservation_id: job.reservation_id, action: "error", success: false, message: job.error }, integrationId);
        break;
      }
    }
    return { processed };
  }), integrationId);
}

export async function retryFailedJobs(integrationId = "sandbox") {
  const reset = checked(await db().rpc("retry_installation_jobs", { p_integration_id: integrationId }));
  if (!reset) throw new AppError("Another synchronization is running. Retry in two minutes.", 409);
}
export async function safelyProcessJobs(integrationId = "sandbox", budgetMs = 40000) {
  try { await processJobs(integrationId, budgetMs); }
  catch (error) {
    if (error instanceof AppError && error.status === 409) return;
    // Only controlled messages are written; never log provider errors.
    try { await logSync({ source: "worker", action: "error", success: false, message: safeError(error) }, integrationId); } catch { /* Durable jobs remain pending when DB is down. */ }
  }
}

// Fair rotation across ready installations. No request spends its entire budget
// on one property; other invocations/webhooks can continue its durable cursor.
export async function processAllJobs() {
  const jobs = checked(await db().rpc("ready_chatbeds_installations")) as { integration_id: string }[];
  const ids = jobs.map(job => job.integration_id);
  for (const id of ids) await safelyProcessJobs(id, 9000);
  return { installationsChecked: ids.length };
}
