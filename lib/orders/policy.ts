// ALL order-safety rules live here, in server code — never in prompts or the UI.
// evaluatePolicy is a pure function: easy to unit test, impossible for the LLM to influence.
// Over-limit NEVER clamps silently — it asks the owner.

import type { PaymentMethod, VoiceItem } from "@/lib/types";
import { itemUnitCount, itemWeightKg } from "@/lib/voice/units";

// ── IST time helpers (Vercel runs in UTC) ────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 3600_000;

export function istParts(now: Date): { minutesOfDay: number; dayOfWeek: number } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dayOfWeek: ist.getUTCDay() };
}

/** UTC instant of 00:00 IST for the IST-date containing `now`. */
export function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const startIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(startIst - IST_OFFSET_MS);
}

/** UTC instant of Monday 00:00 IST for the IST-week containing `now`. */
export function istWeekStart(now: Date): Date {
  const dayStart = istDayStart(now);
  const ist = new Date(dayStart.getTime() + IST_OFFSET_MS);
  const dow = ist.getUTCDay(); // 0=Sun
  const daysBack = (dow + 6) % 7; // Monday=0
  return new Date(dayStart.getTime() - daysBack * 24 * 3600_000);
}

// ── Limits ───────────────────────────────────────────────────────────────────

export type Limits = {
  perOrderPaise: number;
  perDayPaise: number;
  perWeekPaise: number;
  ordersPerDay: number;
  maxUnitsPerItem: number;
  maxKgPerItem: number;
  codPerOrderPaise: number;
  codOrdersPerDay: number;
  lineApprovalPaise: number;
  neverOrderedApprovalPaise: number;
  orderStartMinute: number; // minutes since 00:00 IST
  orderEndMinute: number;
  blocklist: string[];
  /** Supervised week: EVERY order needs owner approval regardless of limits. */
  supervised: boolean;
};

export const DEFAULT_LIMITS: Limits = {
  perOrderPaise: 1000_00,
  perDayPaise: 1500_00,
  perWeekPaise: 5000_00,
  ordersPerDay: 3,
  maxUnitsPerItem: 5,
  maxKgPerItem: 5,
  codPerOrderPaise: 600_00,
  codOrdersPerDay: 1,
  lineApprovalPaise: 400_00,
  neverOrderedApprovalPaise: 150_00,
  orderStartMinute: 6 * 60,
  orderEndMinute: 21 * 60 + 30,
  blocklist: [
    "coin", "gold", "silver", "gift card", "giftcard", "voucher", "phone", "charger", "power bank",
    "cigarette", "tobacco", "beer", "wine", "vodka", "whisky", "rum", "vape", "hookah", "lighter", "condom",
  ],
  supervised: true,
};

export type PolicyLine = {
  name: string; // product name shown to the cook / matched from catalog
  linePaise: number;
  voice?: VoiceItem;
};

export type PolicyContext = {
  toPayPaise: number;
  paymentMethod: PaymentMethod;
  lines: PolicyLine[];
  now: Date;
  spentDayPaise: number; // conservative: includes placing/unknown
  spentWeekPaise: number;
  ordersToday: number;
  codOrdersToday: number;
  orderedBefore: Set<string>; // lowercased product names ever placed
  limits: Limits;
};

export type PolicyReason = { code: string; en: string; hi: string };

export type PolicyResult = { verdict: "allow" | "needs_approval"; reasons: PolicyReason[] };

const r = (code: string, en: string, hi: string): PolicyReason => ({ code, en, hi });

export function evaluatePolicy(ctx: PolicyContext): PolicyResult {
  const { limits } = ctx;
  const reasons: PolicyReason[] = [];
  const rup = (p: number) => `₹${Math.round(p / 100)}`;

  if (limits.supervised) reasons.push(r("SUPERVISED", "supervised week — every order needs approval", "अभी हर ऑर्डर के लिए मालिक से पूछना है"));

  if (ctx.toPayPaise > limits.perOrderPaise)
    reasons.push(r("OVER_ORDER_LIMIT", `order ${rup(ctx.toPayPaise)} > per-order limit ${rup(limits.perOrderPaise)}`, `ऑर्डर ${rup(ctx.toPayPaise)} — सीमा ${rup(limits.perOrderPaise)} से ज़्यादा`));
  if (ctx.spentDayPaise + ctx.toPayPaise > limits.perDayPaise)
    reasons.push(r("OVER_DAY_LIMIT", `daily spend would reach ${rup(ctx.spentDayPaise + ctx.toPayPaise)} > ${rup(limits.perDayPaise)}`, "आज की ख़र्च सीमा से ज़्यादा"));
  if (ctx.spentWeekPaise + ctx.toPayPaise > limits.perWeekPaise)
    reasons.push(r("OVER_WEEK_LIMIT", `weekly spend would exceed ${rup(limits.perWeekPaise)}`, "इस हफ़्ते की ख़र्च सीमा से ज़्यादा"));
  if (ctx.ordersToday >= limits.ordersPerDay)
    reasons.push(r("TOO_MANY_ORDERS", `already ${ctx.ordersToday} orders today (limit ${limits.ordersPerDay})`, "आज के ऑर्डर पूरे हो गए"));

  for (const line of ctx.lines) {
    const nameL = line.name.toLowerCase();
    if (line.voice) {
      const kg = itemWeightKg(line.voice);
      const units = itemUnitCount(line.voice);
      if (kg !== null && kg > limits.maxKgPerItem)
        reasons.push(r("ITEM_QTY", `${line.name}: ${kg} kg > ${limits.maxKgPerItem} kg per item`, `${line.voice.name_hi}: मात्रा बहुत ज़्यादा`));
      if (units !== null && units > limits.maxUnitsPerItem)
        reasons.push(r("ITEM_QTY", `${line.name}: ${units} units > ${limits.maxUnitsPerItem} per item`, `${line.voice.name_hi}: मात्रा बहुत ज़्यादा`));
    }
    if (line.linePaise > limits.lineApprovalPaise)
      reasons.push(r("LINE_TOTAL", `${line.name} costs ${rup(line.linePaise)} > ${rup(limits.lineApprovalPaise)}`, `${line.name} महँगा है (${rup(line.linePaise)})`));
    if (!ctx.orderedBefore.has(nameL) && line.linePaise > limits.neverOrderedApprovalPaise)
      reasons.push(r("NEVER_ORDERED", `${line.name} never ordered before and costs ${rup(line.linePaise)}`, `${line.name} पहली बार मँगाया जा रहा है`));
    for (const word of limits.blocklist)
      if (nameL.includes(word) || (line.voice?.search_en.toLowerCase().includes(word) ?? false))
        reasons.push(r("BLOCKLIST", `${line.name} matches blocklist word '${word}'`, `${line.name} की इजाज़त नहीं है`));
  }

  if (ctx.paymentMethod === "COD") {
    if (ctx.toPayPaise > limits.codPerOrderPaise)
      reasons.push(r("COD_LIMIT", `COD order ${rup(ctx.toPayPaise)} > ${rup(limits.codPerOrderPaise)}`, "कैश ऑर्डर की सीमा से ज़्यादा"));
    if (ctx.codOrdersToday >= limits.codOrdersPerDay)
      reasons.push(r("COD_COUNT", `already ${ctx.codOrdersToday} COD order(s) today`, "आज कैश ऑर्डर हो चुका है"));
  }

  const { minutesOfDay } = istParts(ctx.now);
  if (minutesOfDay < limits.orderStartMinute || minutesOfDay > limits.orderEndMinute)
    reasons.push(r("OUTSIDE_HOURS", "outside ordering hours 06:00–21:30 IST", "अभी ऑर्डर का समय नहीं है (सुबह 6 – रात 9:30)"));

  return { verdict: reasons.length ? "needs_approval" : "allow", reasons };
}
