export interface Integration {
  id: string; property_id: string | null; property_name: string | null;
  chatbeds_status: string; chatbeds_error: string | null; google_calendar_id: string | null;
  auth_mode?: "api_key" | "oauth"; installation_id?: string | null; chatbeds_scope?: string | null;
}
export interface ChatBedsCredentials {
  integration_id: string; installation_id: string; property_id: string;
  access_token_encrypted: string; refresh_token_encrypted: string; expires_at: number; scope: string;
  refresh_started: boolean;
}
export interface GoogleCredentials {
  integration_id: string; account_sub: string; account_email: string | null; calendar_id: string;
  access_token_encrypted: string; refresh_token_encrypted: string; expires_at: number;
}
export interface CalendarMap {
  integration_id: string; property_id: string; reservation_id: string; reservation_ref: string;
  account_sub: string; calendar_id: string; google_event_id: string; generation: number; active: boolean;
  content_hash: string | null; arrival: string; departure: string; reservation_status: string;
  reservation_updated_at: string; last_synced_at: string | null;
}
export interface Summary { created: number; updated: number; deleted: number; skipped: number; failed: number; }
export const emptySummary = (): Summary => ({ created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 });
export interface ManualCursor { date: string; ids: string[]; seenIds: string[]; index: number; searches: string[]; searchIndex: number; searched: boolean; warnings: string[]; }
export interface SyncJob {
  id: string; integration_id: string; kind: "manual" | "webhook"; delivery_id: string | null;
  reservation_id: string | null; event_type: string | null; date_from: string | null; date_to: string | null;
  cursor: Partial<ManualCursor>; summary: Summary; status: "queued" | "processing" | "completed" | "failed";
  attempts: number; next_attempt_at: string; error: string | null;
}
