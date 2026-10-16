import { constantEquals } from "../auth/session";
export function validOAuthState(received: string | null, expected: string | undefined, expires: number, now = Date.now()) {
  return !!received && !!expected && Number.isFinite(expires) && expires > now && constantEquals(received, expected);
}
