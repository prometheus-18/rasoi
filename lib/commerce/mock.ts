// Mock catalog + cart used before Swiggy login and in demo mode.
// The mock can NEVER place an order — checkoutOnce always throws.

import type { Address, CommerceProvider } from "@/lib/commerce/provider";
import { getStore } from "@/lib/store";
import type { CartLine, CartView, PaymentMethod, PaymentOptions, Product, ProviderOrder, RawCheckoutOutcome, TrackInfo } from "@/lib/types";

type CatalogEntry = Product & { keywords: string[] };

const P = (name: string, keywords: string[], variants: [string, number][], brand?: string): CatalogEntry => ({
  name,
  brand,
  keywords,
  variants: variants.map(([packDesc, priceRupees], i) => ({
    spinId: `mock-${name.toLowerCase().replace(/\s+/g, "-")}-${i}`,
    skuId: `sku-${name.toLowerCase().replace(/\s+/g, "-")}-${i}`,
    packDesc,
    pricePaise: Math.round(priceRupees * 100),
    inStock: true,
  })),
});

export const MOCK_CATALOG: CatalogEntry[] = [
  P("Onion", ["onion", "pyaz", "pyaaz", "kanda"], [["1 kg", 38], ["2 kg", 72]]),
  P("Tomato", ["tomato", "tamatar"], [["500 g", 22], ["1 kg", 40]]),
  P("Potato", ["potato", "aloo"], [["1 kg", 32], ["2 kg", 60]]),
  P("Curd", ["curd", "dahi", "yogurt"], [["400 g", 35], ["1 kg", 75]], "Amul Masti"),
  P("Milk", ["milk", "doodh"], [["500 ml", 29], ["1 l", 57]], "Amul Taaza"),
  P("Coriander Leaves", ["coriander", "dhaniya", "cilantro"], [["100 g", 15], ["250 g", 28]]),
  P("Ginger", ["ginger", "adrak"], [["100 g", 18], ["250 g", 36]]),
  P("Garlic", ["garlic", "lehsun"], [["100 g", 22], ["250 g", 45]]),
  P("Green Chilli", ["chilli", "green chilli", "hari mirch"], [["100 g", 12], ["250 g", 24]]),
  P("Lemon", ["lemon", "nimbu", "lime"], [["4 pc", 20], ["250 g", 30]]),
  P("Paneer", ["paneer", "cottage cheese"], [["200 g", 85], ["500 g", 190]], "Amul"),
  P("Bread", ["bread", "pav", "white bread"], [["400 g", 30]], "Britannia"),
  P("Eggs", ["egg", "eggs", "anda", "ande"], [["6 pc", 48], ["12 pc", 90]]),
  P("Wheat Flour (Atta)", ["atta", "wheat flour", "flour"], [["1 kg", 55], ["5 kg", 240]], "Aashirvaad"),
  P("Rice", ["rice", "chawal"], [["1 kg", 65], ["5 kg", 320]], "India Gate"),
  P("Sunflower Oil", ["oil", "cooking oil", "tel", "sunflower"], [["1 l", 135]], "Fortune"),
  P("Salt", ["salt", "namak"], [["1 kg", 25]], "Tata"),
  P("Sugar", ["sugar", "cheeni", "shakkar"], [["1 kg", 48]]),
  P("Capsicum", ["capsicum", "shimla mirch", "bell pepper"], [["250 g", 28], ["500 g", 52]]),
  P("Cucumber", ["cucumber", "kheera"], [["500 g", 24]]),
  P("Spinach", ["spinach", "palak"], [["250 g", 20]]),
  P("Cauliflower", ["cauliflower", "gobhi", "phool gobhi"], [["1 pc", 35]]),
  P("Toor Dal", ["dal", "toor dal", "arhar"], [["1 kg", 150]], "Tata Sampann"),
  P("Ghee", ["ghee"], [["500 ml", 320]], "Amul"),
  P("Butter", ["butter", "makkhan"], [["100 g", 60]], "Amul"),
];

const MIN_ORDER_PAISE = 9900;
const CART_KEY = "mock:cart";

export class MockProvider implements CommerceProvider {
  readonly name = "mock" as const;

  async searchProducts(query: string): Promise<Product[]> {
    const q = query.toLowerCase().trim();
    const scored = MOCK_CATALOG.map((c) => {
      let score = 0;
      if (c.name.toLowerCase() === q) score = 3;
      else if (c.keywords.some((k) => k === q)) score = 3;
      else if (c.keywords.some((k) => q.includes(k) || k.includes(q))) score = 2;
      else if (c.name.toLowerCase().includes(q)) score = 1;
      return { c, score };
    }).filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 6).map((x) => ({ name: x.c.name, brand: x.c.brand, imageUrl: x.c.imageUrl, variants: x.c.variants }));
  }

  async goToItems(): Promise<Product[]> {
    return MOCK_CATALOG.slice(0, 8).map(({ keywords: _k, ...p }) => p);
  }

  async getAddresses(): Promise<Address[]> {
    return [{ id: "mock-address", label: "घर (डेमो)", line: "Demo mode — no real address" }];
  }

  async updateCart(lines: CartLine[]): Promise<CartView> {
    await getStore().setKV(CART_KEY, lines, 24 * 3600_000);
    return this.buildView(lines);
  }

  async getCart(): Promise<CartView> {
    const lines = (await getStore().getKV<CartLine[]>(CART_KEY)) ?? [];
    return this.buildView(lines);
  }

  async clearCart(): Promise<void> {
    await getStore().deleteKV(CART_KEY);
  }

  async getPaymentOptions(): Promise<PaymentOptions> {
    return { cod: { available: true } }; // Swiggy MCP: COD only today
  }

  async checkoutOnce(): Promise<RawCheckoutOutcome> {
    // Real checkouts require the Swiggy adapter + ALLOW_REAL_ORDERS. The mock refuses, always.
    throw new Error("MockProvider cannot place orders (demo mode)");
  }

  async getOrders(): Promise<ProviderOrder[]> {
    return [];
  }

  async getOrderDetails(): Promise<unknown> {
    return null;
  }

  async trackOrder(): Promise<TrackInfo> {
    return { status: "ARRIVING", etaMinutes: 14, message: "डेमो — कोई असली ऑर्डर नहीं" };
  }

  private buildView(lines: CartLine[]): CartView {
    const items = lines
      .map((l) => {
        for (const c of MOCK_CATALOG) {
          const v = c.variants.find((v) => v.spinId === l.spinId);
          if (v)
            return {
              spinId: v.spinId,
              skuId: v.skuId,
              name: c.name,
              packDesc: v.packDesc,
              quantity: l.quantity,
              unitPaise: v.pricePaise,
              linePaise: v.pricePaise * l.quantity,
            };
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const itemTotal = items.reduce((s, i) => s + i.linePaise, 0);
    const fees = itemTotal > 0 && itemTotal < 19900 ? 2500 : 0;
    const warnings: string[] = [];
    if (itemTotal > 0 && itemTotal < MIN_ORDER_PAISE) warnings.push(`Minimum order is ₹99`);
    return {
      items,
      itemTotalPaise: itemTotal,
      feesPaise: fees,
      toPayPaise: itemTotal + fees,
      storeCount: items.length ? 1 : 0,
      warnings,
      removedOutOfStock: [],
      reducedQuantity: [],
      selectedAddressId: "mock-address",
      paymentOptions: { cod: { available: true } },
    };
  }
}
