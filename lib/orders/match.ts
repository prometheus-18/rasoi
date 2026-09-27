// Deterministic matching of parsed voice items → catalog products.
// pantry_map hit → else provider search (4 in parallel). No LLM in this step (Phase 3 adds
// an optional candidate-index-only Gemini call for ambiguous items).

import type { CommerceProvider } from "@/lib/commerce/provider";
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

function nameScore(product: Product, term: string): number {
  const name = product.name.toLowerCase();
  const t = term.toLowerCase();
  if (name === t) return 3;
  if (name.startsWith(t) || t.startsWith(name)) return 2.5;
  if (name.includes(t)) return 2;
  const words = t.split(/\s+/).filter(Boolean);
  const hit = words.filter((w) => name.includes(w)).length;
  return words.length ? (hit / words.length) * 2 : 0;
}

function bestVariant(product: Product, item: VoiceItem): ProductVariant | null {
  const inStock = product.variants.filter((v) => v.inStock);
  if (!inStock.length) return null;
  const want = desiredGrams(item);
  if (want === null) return inStock[0];
  let best = inStock[0];
  let bestFit = Number.POSITIVE_INFINITY;
  for (const v of inStock) {
    const g = packGrams(v.packDesc);
    // prefer a pack that divides the desired amount cleanly; penalize overshoot
    const fit = g === null ? 10 : g <= want ? (want % g === 0 ? want / g - 1 : want / g) : (g / want) * 2;
    if (fit < bestFit) {
      bestFit = fit;
      best = v;
    }
  }
  return best;
}

/** How many units of the chosen variant approximate the requested quantity. */
export function unitsFor(item: VoiceItem, variant: ProductVariant): number {
  const want = desiredGrams(item);
  if (want === null) {
    const q = item.unit === "dozen" ? item.qty : item.qty; // dozen packs are sold as "12 pc" variants
    return Math.min(Math.max(1, Math.round(q)), 10);
  }
  const g = packGrams(variant.packDesc);
  if (g === null || g <= 0) return 1;
  return Math.min(Math.max(1, Math.round(want / g)), 10);
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
    } catch {
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
