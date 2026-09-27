import { describe, expect, it } from "vitest";
import { rulesParse } from "@/lib/voice/rules";

const find = (items: ReturnType<typeof rulesParse>, en: string) => items.find((i) => i.search_en === en);

describe("rulesParse (no-LLM fallback)", () => {
  it("parses a typical Hinglish list", () => {
    const items = rulesParse("pyaz ek kilo, do packet dahi, dhaniya");
    expect(find(items, "onion")).toMatchObject({ qty: 1, unit: "kg", name_hi: "प्याज़" });
    expect(find(items, "curd")).toMatchObject({ qty: 2, unit: "pack" });
    expect(find(items, "coriander leaves")).toMatchObject({ qty: 1, unit: "bunch" });
  });
  it("parses Devanagari", () => {
    const items = rulesParse("आधा किलो टमाटर और एक दर्जन अंडे");
    expect(find(items, "tomato")).toMatchObject({ qty: 0.5, unit: "kg" });
    expect(find(items, "eggs")).toMatchObject({ qty: 1, unit: "dozen" });
  });
  it("handles paav, dhai sau, dedh, paune do", () => {
    expect(find(rulesParse("adrak paav bhar"), "ginger")).toMatchObject({ qty: 250, unit: "g" });
    expect(find(rulesParse("dhai sau gram paneer"), "paneer")).toMatchObject({ qty: 250, unit: "g" });
    expect(find(rulesParse("dedh kilo aloo"), "potato")).toMatchObject({ qty: 1.5, unit: "kg" });
    expect(find(rulesParse("paune do litre doodh"), "milk")).toMatchObject({ qty: 1.75, unit: "l" });
  });
  it("uses sensible default units when none is spoken", () => {
    const items = rulesParse("pyaz, dahi, dhaniya, anda");
    expect(find(items, "onion")?.unit).toBe("kg");
    expect(find(items, "curd")?.unit).toBe("pack");
    expect(find(items, "coriander leaves")?.unit).toBe("bunch");
    expect(find(items, "eggs")?.unit).toBe("dozen");
  });
  it("prefers the longer phrase (hari mirch over mirch, toor dal over dal)", () => {
    expect(find(rulesParse("hari mirch sau gram"), "green chilli")).toMatchObject({ qty: 100, unit: "g" });
    expect(rulesParse("toor dal ek kilo").map((i) => i.search_en)).toEqual(["toor dal"]);
  });
  it("ignores fillers and 'do' as 'give'", () => {
    const items = rulesParse("do kilo aloo de do");
    expect(find(items, "potato")).toMatchObject({ qty: 2, unit: "kg" });
    expect(items).toHaveLength(1);
  });
  it("returns nothing for non-grocery speech", () => {
    expect(rulesParse("namaste kaise ho")).toEqual([]);
  });
});
