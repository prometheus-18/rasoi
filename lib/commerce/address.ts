// Pinned-address fingerprint. Swiggy's get_addresses returns only id / addressLine / addressTag /
// addressCategory / phoneNumber (no pincode, no lat/lng), so the fingerprint is the label plus a hash
// of the address text. Any edit to the saved address changes the hash and blocks checkout.

import { sha256Hex } from "@/lib/crypto";
import type { Address } from "@/lib/commerce/provider";

export type AddressFingerprint = {
  label?: string;
  lineHash?: string; // first 16 hex chars of sha256(normalized addressLine)
  // legacy fields, honored when present
  pincode?: string;
  lat?: number;
  lng?: number;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function lineHash(line: string): string {
  return sha256Hex(norm(line)).slice(0, 16);
}

export function makeFingerprint(a: Address): AddressFingerprint {
  return { label: a.label, ...(a.line ? { lineHash: lineHash(a.line) } : {}) };
}

/** Every field present in the fingerprint must match the live address. */
export function addressMatchesFingerprint(a: Address, fp: AddressFingerprint): boolean {
  if (fp.label !== undefined && (a.label ?? "") !== fp.label) return false;
  if (fp.lineHash !== undefined && (!a.line || lineHash(a.line) !== fp.lineHash)) return false;
  if (fp.pincode !== undefined && a.pincode !== fp.pincode) return false;
  const r2 = (n?: number) => (n === undefined ? undefined : Math.round(n * 100) / 100);
  if (fp.lat !== undefined && r2(fp.lat) !== r2(a.lat)) return false;
  if (fp.lng !== undefined && r2(fp.lng) !== r2(a.lng)) return false;
  return true;
}
