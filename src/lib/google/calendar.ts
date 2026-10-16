import "server-only";
import { AppError } from "../errors";
import { authorizedGoogle } from "./oauth";
import type { CalendarEvent } from "./event-builder";

export class CalendarError extends AppError { constructor(public providerStatus: number) { super(`Google Calendar request failed (HTTP ${providerStatus}). Reconnect if access was revoked, otherwise retry.`, 502); } }
export interface CalendarGateway {
  get(id: string): Promise<{ id: string; status?: string }>;
  insert(id: string, event: CalendarEvent): Promise<void>;
  update(id: string, event: CalendarEvent): Promise<void>;
  remove(id: string): Promise<void>;
}
export function providerStatus(error: unknown): number {
  if (error instanceof CalendarError) return error.providerStatus;
  if (typeof error === "object" && error && "response" in error) {
    const response = error.response as { status?: number };
    return response?.status ?? 0;
  }
  return 0;
}
export async function googleCalendar(integrationId = "sandbox") {
  const google = await authorizedGoogle(integrationId);
  const root = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(google.credentials!.calendar_id)}/events`;
  async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", suffix: string, data?: unknown): Promise<T> {
    try { return await google.request<T>({ url: `${root}${suffix}`, method, data }); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new CalendarError(providerStatus(error));
    }
  }
  const gateway: CalendarGateway = {
    get: id => call("GET", `/${encodeURIComponent(id)}`),
    async insert(id, event) { await call("POST", "?sendUpdates=none", { id, ...event }); },
    async update(id, event) { await call("PATCH", `/${encodeURIComponent(id)}?sendUpdates=none`, event); },
    async remove(id) { await call("DELETE", `/${encodeURIComponent(id)}?sendUpdates=none`); },
  };
  return { gateway, credentials: google.credentials! };
}
