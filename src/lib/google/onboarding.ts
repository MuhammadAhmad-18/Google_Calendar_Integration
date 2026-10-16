import "server-only";
import { cookies } from "next/headers";
import { appAccessMode } from "../config";
import { decryptToken, encryptToken } from "../crypto/tokens";
import { db, checked } from "../db/client";
import { requireHotelUser } from "../auth/session";
import { AppError } from "../errors";

export const GOOGLE_ONBOARDING_COOKIE = "chatbeds_google_setup";
export const GOOGLE_SETUP_TTL = 15 * 60 * 1000;
export function sealGoogleSetup(id: string, userId: string, expires: number) {
  return encryptToken(JSON.stringify({ id, userId, expires }), "google-onboarding");
}
export async function currentGoogleSetup(): Promise<string | null> {
  if (appAccessMode() !== "public") return null;
  const value = (await cookies()).get(GOOGLE_ONBOARDING_COOKIE)?.value;
  if (!value) return null;
  const user = await requireHotelUser();
  let data: { id: string; userId: string; expires: number };
  try { data = JSON.parse(decryptToken(value, "google-onboarding")); } catch { return null; }
  if (data.userId !== user.id || data.expires <= Date.now() || data.expires > Date.now() + GOOGLE_SETUP_TTL || !/^[0-9a-f-]{36}$/i.test(data.id)) return null;
  const row = checked(await db().from("google_onboarding").select("id,valid_until").eq("id", data.id).eq("user_id", user.id).maybeSingle()) as { id: string; valid_until: string } | null;
  return row && Date.parse(row.valid_until) > Date.now() ? row.id : null;
}
export async function attachGoogleSetup(userId: string, setupId: string, integrationId: string) {
  const result = await db().rpc("attach_hotel_google", { p_user_id: userId, p_onboarding_id: setupId, p_integration_id: integrationId });
  if (result.error) throw new AppError("Google setup could not be completed. Continue with Google again.", 409);
}
