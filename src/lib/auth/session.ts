import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { appAccessMode, appUrl, env } from "../config";
import { AppError } from "../errors";
import { hotelAuthClient } from "./hotel-client";

export const SESSION_COOKIE = "chatbeds_admin";
export const OAUTH_COOKIE = "chatbeds_google_state";
export function constantEquals(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
function secret() {
  const value = env("SESSION_SECRET");
  if (value.length < 32) throw new AppError("SESSION_SECRET must have at least 32 random characters.", 503);
  return value;
}
function passwordFingerprint() { return createHmac("sha256", secret()).update(env("ADMIN_PASSWORD")).digest("hex"); }
export function createSession(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + 8 * 60 * 60 * 1000, nonce: randomBytes(16).toString("hex"), fingerprint: passwordFingerprint() })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret()).update(payload).digest("base64url")}`;
}
export function validSession(value: string | undefined, now = Date.now()) {
  if (!value) return false;
  try {
    const [payload, mac, extra] = value.split(".");
    if (!payload || !mac || extra || !constantEquals(createHmac("sha256", secret()).update(payload).digest("base64url"), mac)) return false;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed.exp === "number" && parsed.exp > now && parsed.exp <= now + 8 * 60 * 60 * 1000 && constantEquals(parsed.fingerprint, passwordFingerprint());
  } catch { return false; }
}
export function createHotelSession(userId: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + 8 * 3600000, userId, nonce: randomBytes(32).toString("hex") })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret()).update(payload).digest("base64url")}`;
}
export function validHotelSession(value: string | undefined, userId: string, now = Date.now()) {
  if (!value) return false;
  try {
    const [payload, mac, extra] = value.split(".");
    if (!payload || !mac || extra || !constantEquals(createHmac("sha256", secret()).update(payload).digest("base64url"), mac)) return false;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.userId === userId && typeof parsed.nonce === "string" && parsed.exp > now && parsed.exp <= now + 8 * 3600000;
  } catch { return false; }
}
export async function workspaceUser(): Promise<{ id: string; email: string | null } | null> {
  if (appAccessMode() === "private") return null;
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value) return null;
  const { data, error } = await (await hotelAuthClient()).auth.getUser();
  if (error || !data.user?.email_confirmed_at || !validHotelSession(value, data.user.id)) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
export async function requireHotelUser() {
  const user = await workspaceUser();
  if (!user) throw new AppError("Sign in to your hotel workspace first.", 401);
  return user;
}
export async function isAdmin() { return appAccessMode() === "public" ? !!await workspaceUser() : validSession((await cookies()).get(SESSION_COOKIE)?.value); }
// Retained name for the private-mode API; in public mode this verifies a hotel user.
export async function requireAdmin() { if (!await isAdmin()) throw new AppError("Sign in to your workspace first.", 401); }
export function requireOrigin(request: Request) {
  if (request.headers.get("origin") !== appUrl().origin) throw new AppError("This action must come from the configured app address.", 403);
}
export function cookieOptions(maxAge: number) { return { httpOnly: true, secure: appUrl().protocol === "https:", sameSite: "lax" as const, path: "/", maxAge }; }
