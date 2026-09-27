import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, evaluatePolicy, istDayStart, istWeekStart, type PolicyContext } from "@/lib/orders/policy";

// 2026-09-28 10:00 IST = 04:30 UTC
const IST_MORNING = new Date("2026-09-28T04:30:00Z");
// 23:00 IST = 17:30 UTC
const IST_NIGHT = new Date("2026-09-28T17:30:00Z");

const base = (patch: Partial<PolicyContext> = {}): PolicyContext => ({
  toPayPaise: 400_00,
  paymentMethod: "SWIGGY_MONEY",
  lines: [{ name: "Onion", linePaise: 38_00, voice: { spoken: "pyaz", name_hi: "प्याज़", search_en: "onion", qty: 1, unit: "kg", confidence: 0.9, needs_clarification: false } }],
  now: IST_MORNING,
  spentDayPaise: 0,
  spentWeekPaise: 0,
  ordersToday: 0,
  codOrdersToday: 0,
  orderedBefore: new Set(["onion"]),
  limits: { ...DEFAULT_LIMITS, supervised: false },
  ...patch,
});

const codes = (ctx: PolicyContext) => evaluatePolicy(ctx).reasons.map((r) => r.code);

describe("evaluatePolicy", () => {
  it("allows a normal order within limits", () => {
    expect(evaluatePolicy(base())).toEqual({ verdict: "allow", reasons: [] });
  });
  it("supervised mode always needs approval", () => {
    expect(codes(base({ limits: { ...DEFAULT_LIMITS, supervised: true } }))).toContain("SUPERVISED");
  });
  it("per-order limit", () => {
    expect(codes(base({ toPayPaise: 1001_00 }))).toContain("OVER_ORDER_LIMIT");
  });
  it("daily limit uses conservative spend", () => {
    expect(codes(base({ spentDayPaise: 1200_00 }))).toContain("OVER_DAY_LIMIT");
  });
  it("weekly limit", () => {
    expect(codes(base({ spentWeekPaise: 4700_00 }))).toContain("OVER_WEEK_LIMIT");
  });
  it("orders per day", () => {
    expect(codes(base({ ordersToday: 3 }))).toContain("TOO_MANY_ORDERS");
  });
  it("per-item weight cap (>5 kg)", () => {
    const ctx = base();
    ctx.lines[0].voice!.qty = 6;
    expect(codes(ctx)).toContain("ITEM_QTY");
  });
  it("expensive line needs approval (> Rs 400)", () => {
    expect(codes(base({ lines: [{ name: "Ghee", linePaise: 450_00 }] }))).toContain("LINE_TOTAL");
  });
  it("never-ordered + > Rs 150 needs approval", () => {
    expect(codes(base({ lines: [{ name: "Saffron", linePaise: 200_00 }] }))).toContain("NEVER_ORDERED");
  });
  it("never-ordered but cheap is fine", () => {
    const r = evaluatePolicy(base({ lines: [{ name: "Mint", linePaise: 20_00 }] }));
    expect(r.verdict).toBe("allow");
  });
  it("blocklist words", () => {
    expect(codes(base({ lines: [{ name: "Amazon Gift Card", linePaise: 100_00 }] }))).toContain("BLOCKLIST");
  });
  it("COD per-order and per-day limits (when configured tighter than general)", () => {
    const limits = { ...DEFAULT_LIMITS, supervised: false, codPerOrderPaise: 600_00, codOrdersPerDay: 1 };
    expect(codes(base({ paymentMethod: "COD", toPayPaise: 700_00, limits }))).toContain("COD_LIMIT");
    expect(codes(base({ paymentMethod: "COD", codOrdersToday: 1, limits }))).toContain("COD_COUNT");
  });
  it("outside ordering hours (23:00 IST)", () => {
    expect(codes(base({ now: IST_NIGHT }))).toContain("OUTSIDE_HOURS");
  });
  it("inside hours at 10:00 IST", () => {
    expect(codes(base())).not.toContain("OUTSIDE_HOURS");
  });
});

describe("IST windows", () => {
  it("day start is 00:00 IST (18:30 UTC previous day)", () => {
    expect(istDayStart(IST_MORNING).toISOString()).toBe("2026-09-27T18:30:00.000Z");
  });
  it("week start is Monday 00:00 IST", () => {
    // 2026-09-28 is a Monday in IST
    expect(istWeekStart(IST_MORNING).toISOString()).toBe("2026-09-27T18:30:00.000Z");
    const wednesday = new Date("2026-09-30T04:30:00Z");
    expect(istWeekStart(wednesday).toISOString()).toBe("2026-09-27T18:30:00.000Z");
  });
});
