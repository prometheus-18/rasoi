// Deterministic matching of parsed voice items → catalog products.
// pantry_map hit → else provider search (4 in parallel). No LLM in this step (Phase 3 adds
// an optional candidate-index-only Gemini call for ambiguous items).

import type { CommerceProvider } from "@/lib/commerce/provider";
import { CommerceError } from "@/lib/commerce/swiggy-errors";
import { getStore } from "@/lib/store";
import type { MatchedItem, Product, ProductVariant, VoiceItem } from "@/lib/types";

/** Approx grams for a pack description like "1 kg", "400 g", "500 ml"; null for counts. */
export function packGrams(packDesc: string): number | null {
  const m = packDesc.toLowerCase().match(/([\d.]+)\s*(kg|g|gm|gram|grams|l|ltr|litre|liter|ml)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === "kg" || unit.startsWith("l")) return n * 1000;
  return n;
}

function desiredGrams(item: VoiceItem): number | null {
  switch (item.unit) {
    case "kg":
    case "l":
      return item.qty * 1000;
    case "g":
    case "ml":
      return item.qty;
    default:
      return null;
  }
}

/** Piece count in a pack description like "6 pc", "12 pcs", "1 dozen", "30 pieces"; null if not a count pack. */
export function packCount(packDesc: string): number | null {
  const d = packDesc.toLowerCase();
  if (/dozen/.test(d)) {
    const n = Number(d.match(/([\d.]+)\s*dozen/)?.[1] ?? 1);
    return Number.isFinite(n) ? n * 12 : 12;
  }
  const m = d.match(/([\d.]+)\s*(pc|pcs|piece|pieces|nos|units?|eggs?)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Desired piece count for count-based units ("ek darjan ande" → 12). */
function desiredPieces(item: VoiceItem): number | null {
  switch (item.unit) {
    case "dozen":
      return item.qty * 12;
    case "piece":
      return item.qty;
    default:
      return null;
  }
}

function nameScore(product: Product, term: string): number {
  const full = product.name.toLowerCase();
  const name = full.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim(); // "onion (pyaaz)" → "onion"
  const t = term.toLowerCase();
  const combo = /[,&+]|\bcombo\b|\bpack of\b/.test(full) ? 0.8 : 0; // multi-product packs rank below the plain item
  let score: number;
  if (name === t || full === t) score = 3;
  else if (name.startsWith(t + " ") || t.startsWith(name + " ")) score = 2.5;
  else if (name.startsWith(t) || t.startsWith(name)) score = 2.3;
  else if (name.includes(t)) score = 2;
  else {
    const words = t.split(/\s+/).filter(Boolean);
    const hit = words.filter((w) => name.includes(w)).length;
    score = words.length ? (hit / words.length) * 2 : 0;
  }
  return score - combo;
}

/** Pick the pack whose size fits the requested amount best (weight or piece count). */
function bestVariant(product: Product, item: VoiceItem): ProductVariant | null {
  const inStock = product.variants.filter((v) => v.inStock);
  if (!inStock.length) return null;
  const wantG = desiredGrams(item);
  const wantN = desiredPieces(item);
  if (wantG === null && wantN === null) return inStock[0]; // pack/bunch: any pack is fine
  let best = inStock[0];
  let bestFit = Number.POSITIVE_INFINITY;
  for (const v of inStock) {
    const size = wantG !== null ? packGrams(v.packDesc) : packCount(v.packDesc);
    const want = (wantG ?? wantN)!;
    // prefer a pack that divides the desired amount cleanly; penalize overshoot
    const fit = size === null ? 10 : size <= want ? (want % size === 0 ? want / size - 1 : want / size) : (size / want) * 2;
    if (fit < bestFit) {
      bestFit = fit;
      best = v;
    }
  }
  return best;
}

/** How many units of the chosen variant approximate the requested quantity (capped by Swiggy's maxQuantity). */
export function unitsFor(item: VoiceItem, variant: ProductVariant): number {
  return Math.min(rawUnitsFor(item, variant), variant.maxQuantity ?? 10);
}

function rawUnitsFor(item: VoiceItem, variant: ProductVariant): number {
  const wantG = desiredGrams(item);
  if (wantG !== null) {
    const g = packGrams(variant.packDesc);
    if (g === null || g <= 0) return 1;
    return Math.min(Math.max(1, Math.round(wantG / g)), 10);
  }
  const wantN = desiredPieces(item);
  if (wantN !== null) {
    const n = packCount(variant.packDesc);
    if (n === null || n <= 0) return Math.min(Math.max(1, Math.round(item.unit === "dozen" ? item.qty : item.qty)), 10);
    return Math.min(Math.max(1, Math.round(wantN / n)), 10);
  }
  return Math.min(Math.max(1, Math.round(item.qty)), 10);
}

export async function matchItems(provider: CommerceProvider, items: VoiceItem[]): Promise<MatchedItem[]> {
  const store = getStore();
  const results: MatchedItem[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      results[idx] = await matchOne(item, idx);
    }
  }

  async function matchOne(item: VoiceItem, idx: number): Promise<MatchedItem> {
    const key = `it${idx}`;
    // pantry_map: learned spoken-name → product+variant
    try {
      const learned = (await store.getPantry(item.search_en.toLowerCase())) as { product: Product; variant: ProductVariant } | null;
      if (learned?.variant?.spinId) {
        return { key, voice: item, status: "matched", chosen: learned, quantity: unitsFor(item, learned.variant) };
      }
    } catch {}

    let products: Product[] = [];
    try {
      products = await provider.searchProducts(item.search_en);
    } catch (e) {
      // Outage / expired login is a provider failure, not "product does not exist" — let it escape.
      if (e instanceof CommerceError && ["AUTH", "TRANSIENT", "RATE_LIMIT", "SESSION_419", "CONFIG"].includes(e.code)) throw e;
      return { key, voice: item, status: "not_found", quantity: 1 };
    }
    const scored = products
      .map((p) => ({ p, v: bestVariant(p, item), score: nameScore(p, item.search_en) }))
      .filter((x): x is { p: Product; v: ProductVariant; score: number } => x.v !== null)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return { key, voice: item, status: "not_found", quantity: 1 };

    const top = scored[0];
    const candidates = scored.slice(0, 3).map((x) => ({ product: x.p, variant: x.v }));
    const closeSecond = scored.length > 1 && scored[1].score >= top.score - 0.3 && scored[1].p.name !== top.p.name;
    const ambiguous = item.needs_clarification || top.score < 1.2 || closeSecond;

    if (ambiguous) return { key, voice: item, status: "ambiguous", candidates, quantity: unitsFor(item, top.v) };
    return { key, voice: item, status: "matched", chosen: { product: top.p, variant: top.v }, candidates, quantity: unitsFor(item, top.v) };
  }

  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return results;
}
