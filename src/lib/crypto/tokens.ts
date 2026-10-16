import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config";
import { AppError } from "../errors";

function key() {
  const value = env("TOKEN_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) throw new AppError("TOKEN_ENCRYPTION_KEY must be 32 random bytes in base64.", 503);
  return decoded;
}
export function encryptToken(value: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function decryptToken(value: string, context: string) {
  try {
    const [version, iv, tag, data, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !data || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new AppError("Stored Google credentials cannot be decrypted. Check the encryption key.", 503); }
}
