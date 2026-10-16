import "server-only";
import { appAccessMode } from "../config";
import { db, checked } from "../db/client";
import { integrationColumns } from "../db/store";
import type { Integration } from "../db/types";
import { AppError } from "../errors";
import { requireHotelUser } from "./session";

export async function assertInstallationAccess(integrationId: string) {
  if (appAccessMode() !== "public") return;
  const user = await requireHotelUser();
  const member = checked(await db().from("integration_members").select("integration_id").eq("integration_id", integrationId).eq("user_id", user.id).maybeSingle());
  if (!member) throw new AppError("This property is not available in your workspace.", 404);
}
export async function visibleInstallations(): Promise<Integration[]> {
  if (appAccessMode() !== "public") return checked(await db().from("integration_settings").select(integrationColumns).order("created_at")) as Integration[];
  const user = await requireHotelUser();
  const members = checked(await db().from("integration_members").select("integration_id").eq("user_id", user.id)) as { integration_id: string }[];
  if (!members.length) return [];
  return checked(await db().from("integration_settings").select(integrationColumns).in("id", members.map(row => row.integration_id)).order("created_at")) as Integration[];
}
export async function defaultHotelIntegration() {
  const user = await requireHotelUser();
  return checked(await db().rpc("ensure_hotel_workspace", { p_user_id: user.id })) as string;
}
