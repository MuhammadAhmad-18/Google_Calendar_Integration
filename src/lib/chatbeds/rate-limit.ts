import "server-only";
import { db, checked } from "../db/client";
import { AppError } from "../errors";
export class ChatBedsRetryError extends AppError {
  constructor(public retryAfter: number) { super(`ChatBeds is temporarily unavailable or rate limited. Retry after ${retryAfter} seconds.`, 429); }
}
export function retryAfterSeconds(response: Response) {
  const raw = response.headers.get("retry-after"), seconds = Number(raw);
  if (raw && Number.isFinite(seconds) && seconds >= 0) return Math.min(86400, Math.max(1, Math.ceil(seconds)));
  const date = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(date) ? Math.min(86400, Math.max(1, Math.ceil((date - Date.now()) / 1000))) : 60;
}
export async function claimChatBedsRequest(integrationId: string) {
  const wait = checked(await db().rpc("claim_chatbeds_request", { p_integration_id: integrationId })) as number;
  if (wait > 0) throw new ChatBedsRetryError(wait);
}
export async function pauseChatBedsRequests(integrationId: string, seconds: number) {
  checked(await db().from("integration_settings").update({ chatbeds_retry_at: new Date(Date.now() + seconds * 1000).toISOString() }).eq("id", integrationId));
}
