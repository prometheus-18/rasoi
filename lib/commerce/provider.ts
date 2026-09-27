import type { CartLine, CartView, PaymentMethod, PaymentOptions, Product, ProviderOrder, RawCheckoutOutcome, TrackInfo } from "@/lib/types";
import { getStore } from "@/lib/store";

export type Address = {
  id: string;
  label?: string;
  line?: string;
  pincode?: string;
  lat?: number;
  lng?: number;
};

/**
 * The commerce boundary. The LLM NEVER touches this interface, and nothing behind it
 * is ever serialized to the cook UI except product/cart data (no addresses, no tokens).
 */
export interface CommerceProvider {
  readonly name: "swiggy" | "mock";
  searchProducts(query: string): Promise<Product[]>;
  goToItems(): Promise<Product[]>;
  getAddresses(): Promise<Address[]>;
  /** Replaces the live cart (pinned address enforced inside the adapter). */
  updateCart(lines: CartLine[]): Promise<CartView>;
  getCart(): Promise<CartView>;
  clearCart(): Promise<void>;
  getPaymentOptions(): Promise<PaymentOptions>;
  /**
   * THE checkout call. Called ONLY from lib/orders/checkout.ts, exactly once per order,
   * NEVER retried. The adapter re-checks ALLOW_REAL_ORDERS itself.
   */
  checkoutOnce(args: { addressId: string; paymentMethod: PaymentMethod }): Promise<RawCheckoutOutcome>;
  getOrders(count?: number): Promise<ProviderOrder[]>;
  getOrderDetails(orderId: string): Promise<unknown>;
  trackOrder(orderId: string): Promise<TrackInfo>;
}

/** Swiggy when a login token is stored; otherwise the mock catalog (demo / pre-login). */
export async function getProvider(): Promise<CommerceProvider> {
  const store = getStore();
  const auth = await store.getSwiggyAuth();
  if (auth && auth.expiresAt.getTime() > Date.now() + 60_000) {
    const { SwiggyProvider } = await import("@/lib/commerce/swiggy");
    return new SwiggyProvider();
  }
  const { MockProvider } = await import("@/lib/commerce/mock");
  return new MockProvider();
}
