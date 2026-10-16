import "server-only";
import { randomUUID } from "node:crypto";
import { db, checked } from "./client";
import type { CalendarMap, GoogleCredentials, Integration, SyncJob } from "./types";
import { AppError } from "../errors";

export const integrationColumns = "id,property_id,property_name,chatbeds_status,chatbeds_error,google_calendar_id,auth_mode,installation_id,chatbeds_scope";
export async function getIntegration(integrationId = "sandbox"): Promise<Integration> {
  return checked(await db().from("integration_settings").select(integrationColumns).eq("id", integrationId).single()) as Integration;
}
export async function updateIntegration(values: Partial<Integration>, integrationId = "sandbox") {
  checked(await db().from("integration_settings").update({ ...values, updated_at: new Date().toISOString() }).eq("id", integrationId));
}
export async function getCredentials(integrationId = "sandbox"): Promise<GoogleCredentials | null> {
  return checked(await db().from("google_credentials").select("*").eq("integration_id", integrationId).maybeSingle()) as GoogleCredentials | null;
}
export async function saveCredentials(values: GoogleCredentials) {
  checked(await db().from("google_credentials").upsert({ ...values, updated_at: new Date().toISOString() }));
}
export async function withIntegrationLock<T>(work: () => Promise<T>, integrationId = "sandbox"): Promise<T> {
  const owner = randomUUID();
  const acquired = checked(await db().rpc("acquire_installation_lock", { p_integration_id: integrationId, owner_id: owner }));
  if (!acquired) throw new AppError("Another synchronization or account change is running. Retry in two minutes.", 409);
  try { return await work(); }
  finally { checked(await db().rpc("release_installation_lock", { p_integration_id: integrationId, owner_id: owner })); }
}
export interface MappingStore { find(reservationId: string, propertyId: string, accountSub: string, calendarId: string): Promise<CalendarMap | null>; save(map: CalendarMap): Promise<void>; }
export function installationMappingStore(integrationId = "sandbox"): MappingStore { return {
  async find(reservationId, propertyId, accountSub, calendarId) {
    return checked(await db().from("reservation_calendar_maps").select("*")
      .eq("integration_id", integrationId).eq("reservation_id", reservationId).eq("property_id", propertyId)
      .eq("account_sub", accountSub).eq("calendar_id", calendarId).maybeSingle()) as CalendarMap | null;
  },
  async save(map) {
    checked(await db().from("reservation_calendar_maps").upsert({ ...map, updated_at: new Date().toISOString() },
      { onConflict: "integration_id,property_id,reservation_id,account_sub,calendar_id" }));
  },
}; }
export const mappingStore = installationMappingStore();
export async function logSync(values: { source: string; event_type?: string | null; reservation_id?: string | null; reservation_ref?: string | null; google_event_id?: string | null; action: string; success: boolean; message: string }, integrationId = "sandbox") {
  checked(await db().from("sync_logs").insert({ integration_id: integrationId, ...values }));
}
export async function saveJob(job: SyncJob) {
  checked(await db().from("sync_jobs").update({ cursor: job.cursor, summary: job.summary, status: job.status, attempts: job.attempts, next_attempt_at: job.next_attempt_at, error: job.error, updated_at: new Date().toISOString() }).eq("id", job.id));
}
