import { config as loadDotenv } from 'dotenv';
loadDotenv();

export function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const DB_URL = env(
  'DATABASE_URL',
  'postgres://postgres:postgres@localhost:5433/aiebot'
);
/** Used by KMS client in secrets.ts when KMS_KEY_ID is set. */
export const AWS_REGION = env('AWS_REGION', 'us-east-1');
export const KMS_KEY_ID = env('KMS_KEY_ID', '');
/** Optional; if unset, key is loaded from service_settings (owner dashboard) or must be set there. */
export const OPENAI_API_KEY = env('OPENAI_API_KEY', '');
export const OPENAI_API_URL = env('OPENAI_API_URL', 'https://api.openai.com/v1');
export const OPENAI_CHAT_MODEL = env('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
export const OPENAI_EMBEDDING_MODEL = env('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');

/** Default max completion tokens for chat (non-catalog-heavy turns). */
export const CHAT_COMPLETION_MAX_TOKENS = Math.max(
  256,
  parseInt(env('CHAT_COMPLETION_MAX_TOKENS', '2500'), 10) || 2500
);
/** When WooCommerce sends a catalog outline, allow longer answers for full listings. */
export const CHAT_COMPLETION_MAX_TOKENS_CATALOG = Math.max(
  CHAT_COMPLETION_MAX_TOKENS,
  parseInt(env('CHAT_COMPLETION_MAX_TOKENS_CATALOG', '4500'), 10) || 4500
);
/** Cap parsed product_cards from the model (UI + enrichment). */
export const CHAT_PRODUCT_CARDS_MAX = Math.min(
  100,
  Math.max(3, parseInt(env('CHAT_PRODUCT_CARDS_MAX', '24'), 10) || 24)
);

/** Optional USD per 1M tokens — overrides built-in tables in operator cost estimates. */
function optionalUsdPerMillion(name: string): number | undefined {
  const raw = env(name, '').trim();
  if (raw === '') {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export const COST_EMBED_USD_PER_MILLION = optionalUsdPerMillion('COST_EMBED_USD_PER_MILLION');
export const COST_CHAT_INPUT_USD_PER_MILLION = optionalUsdPerMillion('COST_CHAT_INPUT_USD_PER_MILLION');
export const COST_CHAT_OUTPUT_USD_PER_MILLION = optionalUsdPerMillion('COST_CHAT_OUTPUT_USD_PER_MILLION');
/** Set to a long random string to enable GET /v1/admin/metrics/summary */
export const ADMIN_API_KEY = env('ADMIN_API_KEY', '');
/** Optional override for UI version label (e.g. Lambda when package.json is not on disk) */
export const SERVICE_VERSION = env('SERVICE_VERSION', '');

/** Free tier when no active Stripe subscription (UTC calendar month). */
export const FREE_TIER_MONTHLY_CHATS = Math.max(0, parseInt(env('FREE_TIER_MONTHLY_CHATS', '50'), 10) || 50);

/** Max distinct WooCommerce products indexed when tenant has no paid active plan (slug / subscription). */
export const FREE_TIER_MAX_INDEXED_PRODUCTS = Math.max(
  0,
  parseInt(env('FREE_TIER_MAX_INDEXED_PRODUCTS', '20'), 10) || 20
);

export const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY', '');
export const STRIPE_WEBHOOK_SECRET = env('STRIPE_WEBHOOK_SECRET', '');
/** Public base URL for marketing/pricing (upgrade links, checkout success redirect). */
export const BILLING_UPGRADE_BASE_URL = env('BILLING_UPGRADE_BASE_URL', '');
/** Optional per-tier checkout URLs; fallback: BILLING_UPGRADE_BASE_URL + ?plan=slug&tenant= */
export const BILLING_URL_STARTER = env('BILLING_URL_STARTER', '');
export const BILLING_URL_GROWTH = env('BILLING_URL_GROWTH', '');
export const BILLING_URL_PRO = env('BILLING_URL_PRO', '');
/** Stripe Price IDs (override DB billing_plans.stripe_price_id for Checkout). */
export const STRIPE_PRICE_STARTER = env('STRIPE_PRICE_STARTER', '');
export const STRIPE_PRICE_GROWTH = env('STRIPE_PRICE_GROWTH', '');
export const STRIPE_PRICE_PRO = env('STRIPE_PRICE_PRO', '');
export const STRIPE_CHECKOUT_SUCCESS_URL = env('STRIPE_CHECKOUT_SUCCESS_URL', '');
export const STRIPE_CHECKOUT_CANCEL_URL = env('STRIPE_CHECKOUT_CANCEL_URL', '');
