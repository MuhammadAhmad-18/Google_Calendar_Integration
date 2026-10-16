import "server-only";
import { createClient } from "@supabase/supabase-js";
import { configuredUrl, env } from "../config";
import { AppError } from "../errors";
import { requestSignal } from "../budget";

export function db() {
  return createClient(configuredUrl("SUPABASE_URL").toString(), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: requestSignal(), cache: "no-store" }) },
  });
}
export function checked<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw new AppError("Database operation failed. Check Supabase configuration and migrations.", 503);
  return result.data;
}
