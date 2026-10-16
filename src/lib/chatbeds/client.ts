import "server-only";
import { z } from "zod";
import { configuredUrl } from "../config";
import { AppError } from "../errors";
import { requestSignal } from "../budget";
import { SandboxApiKeyCredentialProvider, type ChatBedsCredentialProvider } from "./credentials";
import { identitySchema, reservationSchema } from "./types";
import { claimChatBedsRequest, pauseChatBedsRequests, retryAfterSeconds, ChatBedsRetryError } from "./rate-limit";

export class ChatBedsClient {
  constructor(private credentials: ChatBedsCredentialProvider = new SandboxApiKeyCredentialProvider(), private integrationId?: string) {}
  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const base = configuredUrl("CHATBEDS_API_BASE_URL").toString().replace(/\/$/, "");
    try {
      const fetchWithToken = async (token: string) => {
        if (this.integrationId) await claimChatBedsRequest(this.integrationId);
        return fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store", signal: requestSignal(),
        });
      };
      const token = await this.credentials.getAccessCredential();
      let response = await fetchWithToken(token);
      if (response.status === 401 && this.credentials.onUnauthorized) {
        response = await fetchWithToken(await this.credentials.onUnauthorized(token));
        if (response.status === 401) await this.credentials.onRejected?.();
      }
      if ([429, 503].includes(response.status)) {
        const wait = retryAfterSeconds(response);
        if (this.integrationId) await pauseChatBedsRequests(this.integrationId, wait);
        throw new ChatBedsRetryError(wait);
      }
      if (!response.ok) throw new AppError(response.status === 401 ? "ChatBeds access is invalid, expired or revoked. Reconnect this property." : response.status === 403 ? "ChatBeds denied this operation. Check reservations:read permission and whether the hotel account is active." : response.status === 429 ? "ChatBeds rate limit reached. Wait before retrying." : `ChatBeds request failed (HTTP ${response.status}). Retry later.`, 502);
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw new AppError("ChatBeds returned an unexpected response shape. Check the current API documentation.", 502);
      return parsed.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("ChatBeds could not be reached within the request timeout.", 502);
    }
  }
  me() { return this.get("/me", identitySchema); }
  async reservation(id: string) {
    return (await this.get(`/reservations/${encodeURIComponent(id)}`, z.object({ reservation: reservationSchema }))).reservation;
  }
  async search(propertyId: string, arrival: string, status?: string) {
    const query = new URLSearchParams({ arrival, limit: "100" });
    if (status) query.set("status", status);
    return (await this.get(`/properties/${encodeURIComponent(propertyId)}/reservations?${query}`, z.object({ reservations: z.array(reservationSchema) }))).reservations;
  }
}
