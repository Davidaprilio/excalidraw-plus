import crypto from "crypto";

// Key for secrets at rest (TOTP): MFA_ENCRYPTION_KEY, else derived from JWT_SECRET
const key = crypto
  .createHash("sha256")
  .update(process.env.MFA_ENCRYPTION_KEY || `mfa:${process.env.JWT_SECRET}`)
  .digest();

/** AES-256-GCM, stored as "iv.tag.ciphertext" (base64url) */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, data] = stored.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** e.g. "k7f3q-9xm2p": 50 bits, easy to type */
export function generateRecoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}

/** Recovery codes are compared ignoring case, spaces and the dash */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");
