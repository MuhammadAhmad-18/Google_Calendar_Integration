import "server-only";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { configuredUrl, env } from "../config";
import { encryptToken, decryptToken } from "../crypto/tokens";
import { getCredentials, saveCredentials } from "../db/store";
import type { GoogleCredentials } from "../db/types";
import { AppError } from "../errors";
import { requestSignal } from "../budget";
import { withGoogleGrantLock } from "./grant-lock";

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"];
export async function revokeGoogleToken(token: string) {
  // The library's revokeToken helper places the token in the URL. Use Google's
  // documented form POST instead so tokens never appear in query strings.
  const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: requestSignal(), cache: "no-store" });
  if (!response.ok) throw new AppError("Google grant revocation failed. Remove the app in your Google account permissions.", 502);
}
export function oauthClient() {
  const client = new OAuth2Client({ clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET"), redirectUri: configuredUrl("GOOGLE_REDIRECT_URI").toString(), transporterOptions: { timeout: 5000, retry: false } });
  // OAuth library methods set their own retry defaults. Override at transport
  // time so token exchange/refresh/revocation also obey the function budget.
  client.transporter.interceptors.request.add({ resolved: async options => ({ ...options, timeout: 5000, retry: false, signal: requestSignal() }) });
  return client;
}
export async function persistTokens(row: GoogleCredentials, tokens: Credentials) {
  const access = tokens.access_token ? encryptToken(tokens.access_token, `${row.account_sub}:access`) : row.access_token_encrypted;
  const refresh = tokens.refresh_token ? encryptToken(tokens.refresh_token, `${row.account_sub}:refresh`) : row.refresh_token_encrypted;
  const next = { ...row, access_token_encrypted: access, refresh_token_encrypted: refresh, expires_at: tokens.expiry_date ?? row.expires_at };
  await saveCredentials(next);
  return next;
}
// Call only while holding the database installation lease: OAuth changes and sync
// cannot refresh/overwrite credentials concurrently across Vercel invocations.
export async function authorizedGoogle(integrationId = "sandbox") {
  let row = await getCredentials(integrationId);
  if (!row) throw new AppError("Google Calendar is not connected.", 409);
  const client = oauthClient();
  client.setCredentials({ access_token: decryptToken(row.access_token_encrypted, `${row.account_sub}:access`), refresh_token: decryptToken(row.refresh_token_encrypted, `${row.account_sub}:refresh`), expiry_date: row.expires_at });
  let changed: Credentials | null = null;
  client.on("tokens", tokens => { changed = { ...(changed ?? {}), ...tokens }; });
  async function flush() {
    if (changed) { row = await persistTokens(row!, changed); changed = null; }
  }
  async function request<T>(options: { url: string; method?: "GET" | "POST" | "PATCH" | "DELETE"; data?: unknown }) {
    return withGoogleGrantLock(async () => { try {
      const current = await getCredentials(integrationId);
      if (!current) throw new AppError("Google Calendar is not connected.", 409);
      row = current;
      client.setCredentials({ access_token: decryptToken(row.access_token_encrypted, `${row.account_sub}:access`), refresh_token: decryptToken(row.refresh_token_encrypted, `${row.account_sub}:refresh`), expiry_date: row.expires_at });
      // The library refreshes expired access tokens (and retries an expired-token 401).
      await client.getAccessToken();
      await flush();
      const result = await client.request<T>({ ...options, timeout: 5000, retry: false, signal: requestSignal() });
      await flush();
      return result.data;
    } catch (error) { await flush(); throw error; } });
  }
  return { credentials: row, request };
}
