import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { appUrl, configuredUrl, env } from "../config";

export type AuthCookie = { name: string; value: string; options: CookieOptions };
export function createHotelAuthClient(adapter: { getAll(): { name: string; value: string }[]; setAll(values: AuthCookie[]): void }) {
  return createServerClient(configuredUrl("SUPABASE_URL").toString(), env("SUPABASE_PUBLISHABLE_KEY"), {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: appUrl().protocol === "https:", path: "/", maxAge: 8 * 3600 },
    cookies: adapter,
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5000), cache: "no-store" }) },
  });
}
export async function hotelAuthClient() {
  const jar = await cookies();
  return createHotelAuthClient({ getAll: () => jar.getAll(), setAll(values) {
    try { for (const { name, value, options } of values) jar.set(name, value, options); }
    catch { /* Server Components cannot set cookies; proxy refreshes them first. */ }
  } });
}
