import "server-only";
import { AppError } from "./errors";

export function appAccessMode(): "private" | "public" {
  const mode = process.env.APP_ACCESS_MODE || "private";
  if (mode !== "private" && mode !== "public") throw new AppError("APP_ACCESS_MODE must be private or public.", 503);
  if (mode === "public" && chatbedsAuthMode() !== "oauth") throw new AppError("Public hotel access requires ChatBeds App OAuth.", 503);
  return mode;
}
export function publicBranding() {
  const retention = Number(process.env.DATA_RETENTION_DAYS || 90);
  const configured = (value: string | undefined) => value && !value.includes("REPLACE_ME") ? value : null;
  return { name: process.env.APP_NAME || "Chatbeds x Google Calendar", operator: configured(process.env.PUBLIC_OPERATOR_NAME),
    supportEmail: configured(process.env.PUBLIC_SUPPORT_EMAIL), retentionDays: Number.isInteger(retention) && retention >= 7 && retention <= 3650 ? retention : 90 };
}
export function dashboardUrl() { const url = appUrl(); if (appAccessMode() === "public") url.pathname = "/dashboard"; return url; }
function loginVariables() { return appAccessMode() === "public" ? ["SUPABASE_PUBLISHABLE_KEY"] : ["ADMIN_PASSWORD"]; }

export const requiredVariables = ["CHATBEDS_API_BASE_URL", "CHATBEDS_API_KEY", "CHATBEDS_WEBHOOK_SECRET", "CHATBEDS_WEBHOOK_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "NEXT_PUBLIC_APP_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TOKEN_ENCRYPTION_KEY", "SESSION_SECRET", "ADMIN_PASSWORD", "CRON_SECRET"] as const;
export function chatbedsAuthMode(): "api_key" | "oauth" {
  const mode = process.env.CHATBEDS_AUTH_MODE || "api_key";
  if (mode !== "api_key" && mode !== "oauth") throw new AppError("CHATBEDS_AUTH_MODE must be api_key or oauth.", 503);
  return mode;
}
export const chatbedsOAuthVariables = ["CHATBEDS_CLIENT_ID", "CHATBEDS_CLIENT_SECRET", "CHATBEDS_REDIRECT_URI", "CHATBEDS_OAUTH_AUTHORIZE_URL", "CHATBEDS_OAUTH_TOKEN_URL", "CHATBEDS_OAUTH_REVOKE_URL"];
export function missingVariables() {
  const keys: string[] = chatbedsAuthMode() === "oauth" ? [...requiredVariables.filter(key => key !== "CHATBEDS_API_KEY"), ...chatbedsOAuthVariables] : [...requiredVariables];
  if (appAccessMode() === "public") { keys.splice(keys.indexOf("ADMIN_PASSWORD"), 1); keys.push("SUPABASE_PUBLISHABLE_KEY", "PUBLIC_SUPPORT_EMAIL", "PUBLIC_OPERATOR_NAME"); }
  return keys.filter(key => !process.env[key] || /REPLACE_ME/.test(process.env[key]!));
}
export function configurationReadiness(missing: readonly string[]) {
  const googleVariables = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "NEXT_PUBLIC_APP_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TOKEN_ENCRYPTION_KEY", "SESSION_SECRET", ...loginVariables()];
  const googleReady = !googleVariables.some(key => missing.includes(key));
  return {
    googleReady,
    syncReady: googleReady && !["CHATBEDS_API_BASE_URL", ...(chatbedsAuthMode() === "api_key" ? ["CHATBEDS_API_KEY"] : chatbedsOAuthVariables)].some(key => missing.includes(key)),
  };
}
export function chatbedsOAuthReadiness(missing: readonly string[]) {
  return chatbedsAuthMode() === "oauth" && ![...chatbedsOAuthVariables, "CHATBEDS_API_BASE_URL", "NEXT_PUBLIC_APP_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TOKEN_ENCRYPTION_KEY", "SESSION_SECRET", ...loginVariables()].some(key => missing.includes(key));
}
export function env(key: string): string {
  const value = process.env[key];
  if (!value || value.includes("REPLACE_ME")) throw new AppError(`Configure ${key} first.`, 503);
  return value;
}
export function configuredUrl(key: string): URL {
  let url: URL;
  try { url = new URL(env(key)); } catch { throw new AppError(`Configure a valid ${key} URL.`, 503); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(local && url.protocol === "http:" && !process.env.VERCEL))) {
    throw new AppError(`${key} must be HTTPS (HTTP localhost is allowed locally).`, 503);
  }
  return url;
}
export function appUrl() {
  const url = configuredUrl("NEXT_PUBLIC_APP_URL");
  if (url.pathname !== "/") throw new AppError("NEXT_PUBLIC_APP_URL must be an origin without a path.", 503);
  return url;
}
export function calendarId() { return process.env.GOOGLE_CALENDAR_ID || "primary"; }
