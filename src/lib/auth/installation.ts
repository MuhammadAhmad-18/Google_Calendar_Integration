import "server-only";
import { cookies } from "next/headers";
import { decryptToken, encryptToken } from "../crypto/tokens";
import { cookieOptions } from "./session";
import { appAccessMode } from "../config";
import { assertInstallationAccess, defaultHotelIntegration } from "./tenancy";
export const INSTALLATION_COOKIE = "chatbeds_installation";
export async function selectedIntegrationId(): Promise<string> {
  const sealed = (await cookies()).get(INSTALLATION_COOKIE)?.value;
  let id: string | null = null;
  try { if (sealed) { const parsed = decryptToken(sealed, "selected-installation"); if (/^[a-zA-Z0-9-]{1,100}$/.test(parsed)) id = parsed; } } catch { /* A damaged cookie selects the user's own default workspace. */ }
  if (appAccessMode() === "public") {
    if (!id) return defaultHotelIntegration();
    await assertInstallationAccess(id);
    return id;
  }
  return id || "sandbox";
}
export function selectedInstallationCookie(id: string) {
  return { name: INSTALLATION_COOKIE, value: encryptToken(id, "selected-installation"), ...cookieOptions(8 * 3600) };
}
