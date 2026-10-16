import "server-only";
import { env } from "../config";
import { AppError } from "../errors";
import { chatbedsAuthMode } from "../config";
import type { Integration } from "../db/types";
import { chatbedsAccessToken, needsChatBedsReconnect } from "./token-store";
export interface ChatBedsCredentialProvider {
  getAccessCredential(propertyId?: string): Promise<string>;
  onUnauthorized?(rejectedToken: string): Promise<string>;
  onRejected?(): Promise<void>;
}
export class SandboxApiKeyCredentialProvider implements ChatBedsCredentialProvider {
  async getAccessCredential() {
    const key = env("CHATBEDS_API_KEY");
    if (!key.startsWith("cbk_")) throw new AppError("API key mode requires a Partner API key starting with cbk_.", 503);
    return key;
  }
}
export class OAuthCredentialProvider implements ChatBedsCredentialProvider {
  constructor(private integrationId: string) {}
  getAccessCredential() { return chatbedsAccessToken(this.integrationId); }
  onUnauthorized(token: string) { return chatbedsAccessToken(this.integrationId, token); }
  onRejected() { return needsChatBedsReconnect(this.integrationId); }
}
export function credentialProvider(integration: Integration): ChatBedsCredentialProvider {
  if (integration.auth_mode === "oauth") {
    if (integration.chatbeds_status === "disconnected") throw new AppError("ChatBeds is disconnected. Reconnect this property.", 409);
    return new OAuthCredentialProvider(integration.id);
  }
  if (chatbedsAuthMode() === "oauth") throw new AppError("Connect this property through ChatBeds App OAuth first.", 409);
  if (integration.id !== "sandbox") throw new AppError("The private Partner API key belongs only to the sandbox installation.", 409);
  return new SandboxApiKeyCredentialProvider();
}
