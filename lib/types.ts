// Shared domain types. Money is ALWAYS integer paise internally.

export type Unit = "g" | "kg" | "ml" | "l" | "pack" | "piece" | "dozen" | "bunch";

/** One item as parsed from the cook's voice note (LLM output, zod-validated). */
export type VoiceItem = {
  spoken: string;
  name_hi: string;
  search_en: string;
  qty: number;
  unit: Unit;
  confidence: number;
  needs_clarification: boolean;
  note?: string;
};

export type ParseResult = { transcript: string; items: VoiceItem[]; model: string; ms: number };

/** A concrete buyable variation of a product on the commerce provider. */
export type ProductVariant = {
  spinId: string;
  skuId: string;
  packDesc: string; // "1 kg", "400 g"
  pricePaise: number;
  mrpPaise?: number;
  inStock: boolean;
};

export type Product = {
  name: string;
  brand?: string;
  imageUrl?: string;
  variants: ProductVariant[];
};

export type MatchStatus = "matched" | "ambiguous" | "not_found";

/** Voice item after matching against the catalog. */
export type MatchedItem = {
  key: string; // stable per-row key within the draft
  voice: VoiceItem;
  status: MatchStatus;
  /** chosen product+variant when matched (or after the cook picks a candidate) */
  chosen?: { product: Product; variant: ProductVariant };
  /** top candidates when ambiguous (cook picks by tap) */
  candidates?: { product: Product; variant: ProductVariant }[];
  quantity: number; // units of the chosen variant
};

export type CartLine = { spinId: string; skuId: string; quantity: number };

export type CartItemView = {
  spinId: string;
  skuId: string;
  name: string;
  imageUrl?: string;
  packDesc?: string;
  quantity: number;
  unitPaise: number;
  linePaise: number;
};

export type PaymentMethod = "SWIGGY_MONEY" | "COD";

export type PaymentOptions = {
  swiggyMoney?: { available: boolean; balancePaise?: number };
  cod?: { available: boolean };
};

export type CartView = {
  items: CartItemView[];
  toPayPaise: number;
  itemTotalPaise?: number;
  feesPaise?: number;
  storeCount: number;
  warnings: string[];
  removedOutOfStock: string[];
  reducedQuantity: string[];
  selectedAddressId?: string;
  paymentOptions?: PaymentOptions;
};

/** Raw result of the ONE checkout call. Never retried. */
export type RawCheckoutOutcome =
  | { kind: "placed"; orderIds: string[]; message?: string; raw?: unknown }
  | { kind: "failed_definite"; message: string; code?: string; raw?: unknown }
  | { kind: "unknown"; message: string; raw?: unknown };

export type ProviderOrder = {
  orderId: string;
  createdAt?: string;
  status?: string;
  totalPaise?: number;
  paymentMethod?: string;
  items?: { name: string; quantity: number }[];
};

export type TrackInfo = { status?: string; etaMinutes?: number; message?: string; raw?: unknown };

export const DRAFT_STATES = [
  "recorded",
  "parsed",
  "matched",
  "cart_synced",
  "awaiting_confirm",
  "awaiting_approval",
  "approved",
  "approved_waiting_login",
  "placing_swiggypay",
  "placing_cod",
  "placed",
  "partially_placed",
  "not_placed",
  "unknown",
  "superseded",
  "expired",
  "rejected",
] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

/** Draft states that block any new checkout (plus unknown orders). */
export const BLOCKING_STATES: DraftState[] = ["placing_swiggypay", "placing_cod", "unknown"];

export type Draft = {
  id: string;
  deviceId: string;
  state: DraftState;
  version: number;
  transcript?: string | null;
  items?: VoiceItem[] | null;
  matched?: MatchedItem[] | null;
  cart?: CartView | null;
  totalPaise?: number | null;
  paymentMethod?: PaymentMethod | null;
  approvedTotalPaise?: number | null;
  error?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OrderState = "placing" | "placed" | "placed_dry" | "partially_placed" | "not_placed" | "unknown";

export type OrderRow = {
  id: string;
  draftId: string;
  idempotencyKey: string;
  state: OrderState;
  totalPaise: number;
  paymentMethod: PaymentMethod;
  swiggyOrderIds?: string[] | null;
  raw?: unknown;
  placedAt?: Date | null;
  createdAt: Date;
};

export type Device = {
  id: string;
  name: string;
  tokenHash: string;
  pinHash?: string | null;
  pinSalt?: string | null;
  pinFails: number;
  locked: boolean;
  revoked: boolean;
  createdAt: Date;
  lastSeen?: Date | null;
};

export const paise = (rupees: number | string | undefined | null): number => {
  const n = Number(String(rupees ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const rupeesText = (p: number | null | undefined): string => {
  const r = (p ?? 0) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
};
