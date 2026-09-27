// Deterministic post-processing of LLM-parsed quantities. Pure functions — unit tested.

import type { Unit, VoiceItem } from "@/lib/types";

const UNITS: Unit[] = ["g", "kg", "ml", "l", "pack", "piece", "dozen", "bunch"];

/** Normalize one item's qty/unit into something sane. Never invents, only corrects obvious unit slips. */
export function normalizeItem(item: VoiceItem): VoiceItem {
  let { qty, unit } = item;
  if (!UNITS.includes(unit)) unit = "piece";
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;

  // "250 kg dhaniya" is really 250 g; nobody orders ≥ 25 kg of anything by voice.
  if (unit === "kg" && qty >= 25) {
    unit = "g";
  }
  if (unit === "l" && qty >= 25) {
    unit = "ml";
  }
  // sub-gram / sub-ml fractions ("0.25 g") are misparses of paav etc. — treat as kg/l fractions
  if (unit === "g" && qty < 1) {
    unit = "kg";
  }
  if (unit === "ml" && qty < 1) {
    unit = "l";
  }
  // whole-unit conversions for tiny gram counts: "1 g dahi" was almost surely "1 kg"
  if ((unit === "g" || unit === "ml") && qty <= 5 && Number.isInteger(qty)) {
    unit = unit === "g" ? "kg" : "l";
  }

  // sanity caps per unit family (policy enforces the real limits; this only stops absurd parses)
  if (unit === "g" || unit === "ml") qty = Math.min(qty, 5000);
  else if (unit === "kg" || unit === "l") qty = Math.min(qty, 24);
  else qty = Math.min(qty, 99);
  qty = Math.round(qty * 1000) / 1000;
  return { ...item, qty, unit };
}

/** Merge exact duplicates (same search term + unit) by summing qty. */
export function mergeDuplicates(items: VoiceItem[]): VoiceItem[] {
  const out: VoiceItem[] = [];
  for (const it of items) {
    const prev = out.find((o) => o.search_en.toLowerCase() === it.search_en.toLowerCase() && o.unit === it.unit);
    if (prev) prev.qty = Math.round((prev.qty + it.qty) * 1000) / 1000;
    else out.push({ ...it });
  }
  return out;
}

export function normalizeItems(items: VoiceItem[]): VoiceItem[] {
  return mergeDuplicates(items.map(normalizeItem));
}

/** Approximate weight in kg for the per-item weight limit (liquids count as kg). */
export function itemWeightKg(item: VoiceItem): number | null {
  switch (item.unit) {
    case "kg":
    case "l":
      return item.qty;
    case "g":
    case "ml":
      return item.qty / 1000;
    default:
      return null; // count-based units — limited by unit count instead
  }
}

/** Count-based quantity for the per-item unit limit. */
export function itemUnitCount(item: VoiceItem): number | null {
  switch (item.unit) {
    case "pack":
    case "piece":
    case "bunch":
      return item.qty;
    case "dozen":
      return item.qty * 12;
    default:
      return null;
  }
}

const UNIT_HI: Record<Unit, string> = {
  g: "ग्राम",
  kg: "किलो",
  ml: "मि.ली.",
  l: "लीटर",
  pack: "पैकेट",
  piece: "",
  dozen: "दर्जन",
  bunch: "गड्डी",
};

/** "1 किलो", "250 ग्राम", "2 पैकेट", "3" — for UI and Telegram. */
export function qtyTextHi(item: Pick<VoiceItem, "qty" | "unit">): string {
  const qty = Number.isInteger(item.qty) ? String(item.qty) : String(item.qty);
  const unit = UNIT_HI[item.unit] ?? "";
  return unit ? `${qty} ${unit}` : qty;
}
