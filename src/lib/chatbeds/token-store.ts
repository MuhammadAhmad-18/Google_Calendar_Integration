import "server-only";
import { randomUUID } from "node:crypto";
import { db, checked } from "../db/client";
import { updateIntegration } from "../db/store";
import type { ChatBedsCredentials } from "../db/types";
import { encryptToken, decryptToken } from "../crypto/tokens";
import { AppError } from "../errors";
import { refreshChatBedsTokens, type ChatBedsTokens } from "./oauth";
import { ChatBedsRetryError } from "./rate-limit";
import { appAccessMode } from "../config";
import { requireHotelUser } from "../auth/session";
import { assertInstallationAccess } from "../auth/tenancy";

export const chatbedsTokenContext = (installationId: string, kind: "access" | "refresh") => `chatbeds:${installationId}:${kind}`;
export async function getChatBedsCredentials(integrationId: string) {
  return checked(await db().from("chatbeds_credentials").select("*").eq("integration_id", integrationId).maybeSingle()) as ChatBedsCredentials | null;
}
export async function installChatBeds(tokens: ChatBedsTokens, googleSetupId?: string) {
  let userId: string | undefined;
  if (appAccessMode() === "public") {
    userId = (await requireHotelUser()).id;
    const previous = checked(await db().from("integration_settings").select("id").eq("property_id", tokens.property_id).maybeSingle()) as { id: string } | null;
    if (previous) await assertInstallationAccess(previous.id);
    if (!googleSetupId) throw new AppError("Continue with Google before connecting your property.", 409);
  }
  return checked(await db().rpc(userId ? "install_hotel_with_google" : "install_chatbeds", { ...(userId ? { p_user_id: userId, p_onboarding_id: googleSetupId } : {}), p_property_id: tokens.property_id, p_installation_id: tokens.installation_id,
    p_access: encryptToken(tokens.access_token, chatbedsTokenContext(tokens.installation_id, "access")),
    p_refresh: encryptToken(tokens.refresh_token, chatbedsTokenContext(tokens.installation_id, "refresh")),
    p_expiry: Date.now() + tokens.expires_in * 1000, p_scope: tokens.scope })) as string;
}
export async function withChatBedsRefreshLock<T>(integrationId: string, work: (owner: string) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  if (!checked(await db().rpc("acquire_chatbeds_refresh", { p_integration_id: integrationId, p_owner: owner })))
    throw new AppError("ChatBeds credentials are being refreshed or changed. Retry shortly.", 409);
  try { return await work(owner); }
  finally { checked(await db().rpc("release_chatbeds_refresh", { p_integration_id: integrationId, p_owner: owner })); }
}
export async function needsChatBedsReconnect(integrationId: string, message = "ChatBeds access stopped. Reconnect this property.") {
  await updateIntegration({ chatbeds_status: "disconnected", chatbeds_error: message }, integrationId);
}

export async function chatbedsAccessToken(integrationId: string, rejectedToken?: string): Promise<string> {
  return withChatBedsRefreshLock(integrationId, async owner => {
    // Re-read AFTER taking the lease; a previous invocation may have rotated it.
    const row = await getChatBedsCredentials(integrationId);
    if (!row) throw new AppError("ChatBeds is not connected. Connect this property.", 409);
    if (row.refresh_started) {
      await needsChatBedsReconnect(integrationId, "A ChatBeds token refresh had an uncertain outcome. Reconnect to avoid reusing a single-use refresh token.");
      throw new AppError("ChatBeds token refresh could not be confirmed. Reconnect this property.", 409);
    }
    const access = decryptToken(row.access_token_encrypted, chatbedsTokenContext(row.installation_id, "access"));
    // A 401 for an older token must not rotate the newly stored pair again.
    if (row.expires_at > Date.now() + 60000 && (!rejectedToken || rejectedToken !== access)) return access;
    const pause = checked(await db().from("integration_settings").select("chatbeds_retry_at").eq("id", integrationId).single()) as { chatbeds_retry_at: string | null };
    if (pause.chatbeds_retry_at && Date.parse(pause.chatbeds_retry_at) > Date.now())
      throw new ChatBedsRetryError(Math.max(1, Math.ceil((Date.parse(pause.chatbeds_retry_at) - Date.now()) / 1000)));
    if (!checked(await db().rpc("begin_chatbeds_refresh", { p_integration_id: integrationId, p_owner: owner })))
      throw new AppError("ChatBeds refresh could not be started safely. Reconnect this property.", 409);
    try {
      const tokens = await refreshChatBedsTokens(decryptToken(row.refresh_token_encrypted, chatbedsTokenContext(row.installation_id, "refresh")));
      if (tokens.property_id !== row.property_id || tokens.installation_id !== row.installation_id)
        throw new AppError("ChatBeds returned credentials for a different installation. Reconnect this property.", 502);
      const saved = checked(await db().rpc("finish_chatbeds_refresh", {
        p_integration_id: integrationId, p_owner: owner,
        p_access: encryptToken(tokens.access_token, chatbedsTokenContext(row.installation_id, "access")),
        p_refresh: encryptToken(tokens.refresh_token, chatbedsTokenContext(row.installation_id, "refresh")),
        p_expiry: Date.now() + tokens.expires_in * 1000, p_scope: tokens.scope,
      }));
      if (!saved) throw new AppError("ChatBeds token rotation could not be saved safely. Reconnect this property.", 503);
      await updateIntegration({ chatbeds_scope: tokens.scope, chatbeds_status: "connected", chatbeds_error: null }, integrationId);
      return tokens.access_token;
    } catch (error) {
      if (error instanceof ChatBedsRetryError) {
        // Official docs guarantee a 429 refused the request before consuming it.
        checked(await db().rpc("cancel_chatbeds_refresh", { p_integration_id: integrationId, p_owner: owner }));
        checked(await db().from("integration_settings").update({ chatbeds_retry_at: new Date(Date.now() + error.retryAfter * 1000).toISOString() }).eq("id", integrationId));
        throw error;
      }
      // Never retry a rotating refresh POST. Even a timeout may have consumed it.
      await needsChatBedsReconnect(integrationId, "ChatBeds refresh failed or could not be confirmed. Check app credentials and reconnect this property.");
      throw error;
    }
  });
}
