import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

// ── AES-256-GCM token store (versioned key: "v1:<base64 32 bytes>") ─────────

function parseKey(raw: string): { version: string; key: Buffer } {
  const idx = raw.indexOf(":");
  if (idx < 1) throw new Error("TOKEN_ENC_KEY must look like 'v1:<base64 32 bytes>'");
  const version = raw.slice(0, idx);
  const key = Buffer.from(raw.slice(idx + 1), "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENC_KEY key part must decode to 32 bytes");
  return { version, key };
}

export function aesEncrypt(plain: string): string {
  if (!env.tokenEncKey) throw new Error("TOKEN_ENC_KEY is not set");
  const { version, key } = parseKey(env.tokenEncKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function aesDecrypt(blob: string): string {
  if (!env.tokenEncKey) throw new Error("TOKEN_ENC_KEY is not set");
  const [version, ivB64, tagB64, ctB64] = blob.split(":");
  const { version: keyVersion, key } = parseKey(env.tokenEncKey);
  if (version !== keyVersion) throw new Error(`token encrypted with key ${version}, current key is ${keyVersion} — rotate/re-login`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

// ── Hashing / random ────────────────────────────────────────────────────────

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const randomDigits = (n: number): string => {
  let out = "";
  while (out.length < n) out += randomBytes(4).readUInt32BE(0) % 10;
  return out.slice(0, n);
};

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // still do a comparison to keep timing flat-ish
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// ── HMAC (single-use action tokens, pin cookies) ────────────────────────────

export function hmacSign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function hmacVerify(data: string, sig: string, secret: string): boolean {
  return timingSafeEqualStr(hmacSign(data, secret), sig);
}

// ── PIN hashing (peppered scrypt; PINs are short so the pepper is the secret) ─

export function pinHash(pin: string, salt: string): string {
  const pepper = env.pinPepper ?? "";
  return scryptSync(`${pepper}:${pin}`, salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64");
}

export function pinVerify(pin: string, salt: string, expectedHash: string): boolean {
  return timingSafeEqualStr(pinHash(pin, salt), expectedHash);
}
