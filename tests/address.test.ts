import { describe, expect, it } from "vitest";
import { addressMatchesFingerprint, makeFingerprint } from "@/lib/commerce/address";

const home = { id: "a1", label: "Home", line: "Rahul Verma: 1st Floor, C-1171, Block C, Sushant Lok Phase I, Gurugram" };

describe("address fingerprint", () => {
  it("matches the same address and ignores whitespace/case noise", () => {
    const fp = makeFingerprint(home);
    expect(addressMatchesFingerprint(home, fp)).toBe(true);
    expect(addressMatchesFingerprint({ ...home, line: home.line.toUpperCase() + "  " }, fp)).toBe(true);
  });
  it("rejects an edited address text or label", () => {
    const fp = makeFingerprint(home);
    expect(addressMatchesFingerprint({ ...home, line: home.line.replace("C-1171", "C-1172") }, fp)).toBe(false);
    expect(addressMatchesFingerprint({ ...home, label: "Work" }, fp)).toBe(false);
  });
  it("honors legacy pincode/lat/lng fields when present", () => {
    expect(addressMatchesFingerprint({ ...home, pincode: "122002", lat: 28.4612, lng: 77.0812 }, { pincode: "122002", lat: 28.46, lng: 77.08 })).toBe(true);
    expect(addressMatchesFingerprint({ ...home, pincode: "110001" }, { pincode: "122002" })).toBe(false);
  });
});
