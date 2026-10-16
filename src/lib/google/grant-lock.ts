import "server-only";
import { randomUUID } from "node:crypto";
import { db, checked } from "../db/client";
import { AppError } from "../errors";
export async function withGoogleGrantLock<T>(work: () => Promise<T>) {
  const owner = randomUUID();
  if (!checked(await db().rpc("acquire_google_grant_lock", { p_owner: owner }))) throw new AppError("Another Google account operation is running. Retry shortly.", 409);
  try { return await work(); }
  finally { checked(await db().rpc("release_google_grant_lock", { p_owner: owner })); }
}
