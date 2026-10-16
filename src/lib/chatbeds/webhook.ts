import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(raw: Buffer, header: string | null, secret: string, nowSeconds = Date.now() / 1000): boolean {
  const parts = Object.fromEntries((header || "").split(",").map(part => part.trim().split("=", 2)));
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || Math.abs(nowSeconds - timestamp) > 300 || !/^[a-f0-9]{64}$/.test(parts.v1 || "")) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  const signature = Buffer.from(parts.v1, "hex");
  return expected.length === signature.length && timingSafeEqual(expected, signature);
}
