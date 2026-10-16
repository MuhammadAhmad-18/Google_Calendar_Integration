import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { configuredUrl, env } from "../config";
import { requestSignal } from "../budget";
import { AppError } from "../errors";
import { ChatBedsRetryError, retryAfterSeconds } from "./rate-limit";

export const CHATBEDS_SCOPE = "reservations:read";
export const tokenSchema = z.object({
  access_token: z.string().startsWith("cbat_"), refresh_token: z.string().startsWith("cbrt_"),
  token_type: z.literal("Bearer"), expires_in: z.number().int().positive().max(86400),
  scope: z.string(), property_id: z.uuid(), installation_id: z.uuid(),
});
export type ChatBedsTokens = z.infer<typeof tokenSchema>;
export class ChatBedsOAuthError extends AppError {
  constructor(public code: string, status = 502) {
    super(code === "invalid_grant" ? "ChatBeds authorization expired or was revoked. Reconnect this property." : code === "invalid_client" ? "ChatBeds rejected the app credentials. Check the client ID and secret, or app suspension." : "ChatBeds authorization could not be completed. Check the app settings and reconnect.", status);
  }
}
function clientCredentials() {
  const client_id = env("CHATBEDS_CLIENT_ID"), client_secret = env("CHATBEDS_CLIENT_SECRET");
  if (!client_id.startsWith("cba_") || !client_secret.startsWith("cbs_")) throw new AppError("Configure valid ChatBeds app credentials (cba_ client ID and cbs_ client secret).", 503);
  return { client_id, client_secret };
}
export function authorizationUrl(state: string, verifier: string) {
  const url = configuredUrl("CHATBEDS_OAUTH_AUTHORIZE_URL");
  url.search = new URLSearchParams({ response_type: "code", client_id: clientCredentials().client_id,
    redirect_uri: configuredUrl("CHATBEDS_REDIRECT_URI").toString(), scope: CHATBEDS_SCOPE, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  return url;
}
async function tokenRequest(values: Record<string, string>): Promise<ChatBedsTokens> {
  let response: Response;
  try {
    response = await fetch(configuredUrl("CHATBEDS_OAUTH_TOKEN_URL"), { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...values, ...clientCredentials() }), signal: requestSignal() });
  } catch (error) { if (error instanceof AppError) throw error; throw new ChatBedsOAuthError("uncertain_response"); }
  const data: unknown = await response.json().catch(() => null);
  if (response.status === 429) throw new ChatBedsRetryError(retryAfterSeconds(response));
  if (!response.ok) {
    const code = z.object({ error: z.enum(["invalid_grant", "invalid_client", "slow_down", "unsupported_grant_type"]) }).safeParse(data);
    throw new ChatBedsOAuthError(code.success ? code.data.error : "provider_error");
  }
  const parsed = tokenSchema.safeParse(data);
  if (!parsed.success) throw new ChatBedsOAuthError("invalid_response");
  if (!parsed.data.scope.split(/\s+/).includes(CHATBEDS_SCOPE)) throw new AppError("ChatBeds did not grant reservations:read. Enable the scope on your app and reconnect.", 403);
  return parsed.data;
}
export function exchangeChatBedsCode(code: string, verifier: string) {
  return tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: configuredUrl("CHATBEDS_REDIRECT_URI").toString() });
}
export function refreshChatBedsTokens(token: string) { return tokenRequest({ grant_type: "refresh_token", refresh_token: token }); }
export async function revokeChatBedsToken(token: string) {
  try {
    const response = await fetch(configuredUrl("CHATBEDS_OAUTH_REVOKE_URL"), { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, ...clientCredentials() }), signal: requestSignal() });
    if (!response.ok) throw new AppError("ChatBeds revocation failed. Disconnect the app on the property's Apps page.", 502);
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError("ChatBeds revocation could not be confirmed. Disconnect it on the property's Apps page.", 502); }
}
