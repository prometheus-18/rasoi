// Central env access. Getters so values are read at request time, not build time.
// SAFETY: allowRealOrders is true ONLY in the Vercel Production environment —
// preview/dev deployments are always dry no matter what the variable says.

export const env = {
  get swiggyMcpUrl() {
    return process.env.SWIGGY_MCP_URL || "https://mcp.swiggy.com/im";
  },
  get swiggyAuthBase() {
    return process.env.SWIGGY_AUTH_BASE || "https://mcp.swiggy.com/auth";
  },
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY || undefined;
  },
  get groqApiKey() {
    return process.env.GROQ_API_KEY || undefined;
  },
  /** Setup-phase owner login (before the Telegram bot exists): /api/admin/session?key=… */
  get adminSetupKey() {
    return process.env.ADMIN_SETUP_KEY || undefined;
  },
  get telegramBotToken() {
    return process.env.TELEGRAM_BOT_TOKEN || undefined;
  },
  get ownerChatId() {
    return process.env.OWNER_CHAT_ID || undefined;
  },
  get telegramWebhookSecret() {
    return process.env.TELEGRAM_WEBHOOK_SECRET || undefined;
  },
  get databaseUrl() {
    return process.env.DATABASE_URL || undefined;
  },
  get tokenEncKey() {
    return process.env.TOKEN_ENC_KEY || undefined;
  },
  get pinPepper() {
    return process.env.PIN_PEPPER || undefined;
  },
  get cronSecret() {
    return process.env.CRON_SECRET || undefined;
  },
  get pinnedAddressId() {
    return process.env.PINNED_ADDRESS_ID || undefined;
  },
  get pinnedAddressFingerprint() {
    return process.env.PINNED_ADDRESS_FINGERPRINT || undefined;
  },
  /** "lat,lng" of the pinned address (optional; only used for track_order, which requires coordinates). */
  get pinnedAddressLatLng(): { lat: number; lng: number } | undefined {
    const raw = process.env.PINNED_ADDRESS_LATLNG;
    if (!raw) return undefined;
    const [lat, lng] = raw.split(",").map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  },
  get isProduction() {
    return process.env.VERCEL_ENV === "production";
  },
  /** The ONLY flag that permits a real checkout call. Production-only by construction. */
  get allowRealOrders() {
    return process.env.ALLOW_REAL_ORDERS === "true" && process.env.VERCEL_ENV === "production";
  },
  /** No database configured → in-memory demo store, mock catalog, nothing real can happen. */
  get isDemo() {
    return !process.env.DATABASE_URL;
  },
  get appUrl() {
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return "http://localhost:3000";
  },
  get telegramConfigured() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.OWNER_CHAT_ID);
  },
};

export type SetupStatus = {
  database: boolean;
  gemini: boolean;
  groq: boolean;
  telegram: boolean;
  tokenEncKey: boolean;
  pinPepper: boolean;
  cronSecret: boolean;
  pinnedAddress: boolean;
  allowRealOrders: boolean;
  demo: boolean;
};

export function setupStatus(): SetupStatus {
  return {
    database: Boolean(env.databaseUrl),
    gemini: Boolean(env.geminiApiKey),
    groq: Boolean(env.groqApiKey),
    telegram: env.telegramConfigured,
    tokenEncKey: Boolean(env.tokenEncKey),
    pinPepper: Boolean(env.pinPepper),
    cronSecret: Boolean(env.cronSecret),
    pinnedAddress: Boolean(env.pinnedAddressId),
    allowRealOrders: env.allowRealOrders,
    demo: env.isDemo,
  };
}
