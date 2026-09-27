import { describe, expect, it } from "vitest";
import { itemUnitCount, itemWeightKg, mergeDuplicates, normalizeItem, qtyTextHi } from "@/lib/voice/units";
import type { VoiceItem } from "@/lib/types";

const item = (patch: Partial<VoiceItem>): VoiceItem => ({
  spoken: "x",
  name_hi: "x",
  search_en: "onion",
  qty: 1,
  unit: "kg",
  confidence: 0.9,
  needs_clarification: false,
  ...patch,
});

describe("normalizeItem", () => {
  it("fixes '250 kg' to grams", () => {
    expect(normalizeItem(item({ qty: 250, unit: "kg" }))).toMatchObject({ qty: 250, unit: "g" });
  });
  it("fixes sub-gram fractions to kg (paav misparse)", () => {
    expect(normalizeItem(item({ qty: 0.25, unit: "g" }))).toMatchObject({ qty: 0.25, unit: "kg" });
  });
  it("fixes tiny integer gram counts to kg", () => {
    expect(normalizeItem(item({ qty: 1, unit: "g" }))).toMatchObject({ qty: 1, unit: "kg" });
  });
  it("keeps sane values", () => {
    expect(normalizeItem(item({ qty: 0.5, unit: "kg" }))).toMatchObject({ qty: 0.5, unit: "kg" });
    expect(normalizeItem(item({ qty: 250, unit: "g" }))).toMatchObject({ qty: 250, unit: "g" });
  });
  it("defaults bad qty/unit", () => {
    expect(normalizeItem(item({ qty: -3, unit: "banana" as never }))).toMatchObject({ qty: 1, unit: "piece" });
  });
});

describe("mergeDuplicates", () => {
  it("sums same item+unit", () => {
    const out = mergeDuplicates([item({ qty: 1 }), item({ qty: 0.5 })]);
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(1.5);
  });
  it("keeps different units separate", () => {
    expect(mergeDuplicates([item({ unit: "kg" }), item({ unit: "pack" })])).toHaveLength(2);
  });
});

describe("weights and counts for policy", () => {
  it("weight units", () => {
    expect(itemWeightKg(item({ qty: 2, unit: "kg" }))).toBe(2);
    expect(itemWeightKg(item({ qty: 500, unit: "g" }))).toBe(0.5);
    expect(itemWeightKg(item({ qty: 2, unit: "pack" }))).toBeNull();
  });
  it("count units (a dozen is one pack for the limit)", () => {
    expect(itemUnitCount(item({ qty: 2, unit: "dozen" }))).toBe(2);
    expect(itemUnitCount(item({ qty: 3, unit: "pack" }))).toBe(3);
    expect(itemUnitCount(item({ qty: 1, unit: "kg" }))).toBeNull();
  });
});

describe("qtyTextHi", () => {
  it("renders hindi units with latin digits", () => {
    expect(qtyTextHi({ qty: 1, unit: "kg" })).toBe("1 किलो");
    expect(qtyTextHi({ qty: 250, unit: "g" })).toBe("250 ग्राम");
    expect(qtyTextHi({ qty: 3, unit: "piece" })).toBe("3");
  });
});
