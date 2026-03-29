import type { PoolClient } from 'pg';
import {
  BILLING_URL_GROWTH,
  BILLING_URL_PRO,
  BILLING_URL_STARTER,
  BILLING_UPGRADE_BASE_URL,
  FREE_TIER_MAX_INDEXED_PRODUCTS,
  FREE_TIER_MONTHLY_CHATS,
  STRIPE_PRICE_GROWTH,
  STRIPE_PRICE_PRO,
  STRIPE_PRICE_STARTER,
  STRIPE_SECRET_KEY,
} from './config.js';
import { countDistinctIndexedProducts } from './chunksRepo.js';
import type { TenantRow } from './tenants.js';

const PAID_STATUSES = new Set(['active', 'trialing']);

export function subscriptionIsPaid(status: string | null | undefined): boolean {
  if (!status) return false;
  return PAID_STATUSES.has(status.toLowerCase());
}

export async function getChatsUsedUtcMonth(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ c: string }>(
    `SELECT COALESCE(SUM(chat_count), 0)::text AS c
     FROM usage_daily
     WHERE tenant_id = $1
       AND day >= date_trunc('month', timezone('utc', now()))::date
       AND day <= (timezone('utc', now()))::date`,
    [tenantId]
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function getMonthlyChatQuotaForTenant(
  client: PoolClient,
  tenant: TenantRow
): Promise<number> {
  const o = tenant.monthly_chat_quota_override;
  if (o != null && Number.isFinite(Number(o))) {
    return Math.max(0, Math.min(50_000_000, Math.floor(Number(o))));
  }
  if (subscriptionIsPaid(tenant.subscription_status) && tenant.billing_plan_slug) {
    const r = await client.query<{ monthly_chat_limit: string }>(
      `SELECT monthly_chat_limit::text FROM billing_plans WHERE slug = $1 AND active = TRUE`,
      [tenant.billing_plan_slug]
    );
    if (r.rows[0]) {
      return Math.max(0, Number(r.rows[0].monthly_chat_limit));
    }
  }
  return FREE_TIER_MONTHLY_CHATS;
}

/** 0 = unlimited (plan or explicit zero). */
export async function getMaxIndexedProductsForTenant(
  client: PoolClient,
  tenant: TenantRow
): Promise<number> {
  if (subscriptionIsPaid(tenant.subscription_status) && tenant.billing_plan_slug) {
    const r = await client.query<{ max_indexed_products: string }>(
      `SELECT max_indexed_products::text FROM billing_plans WHERE slug = $1 AND active = TRUE`,
      [tenant.billing_plan_slug]
    );
    if (r.rows[0]) {
      const n = Number(r.rows[0].max_indexed_products);
      if (Number.isFinite(n) && n >= 0) {
        return n;
      }
    }
  }
  return FREE_TIER_MAX_INDEXED_PRODUCTS;
}

export type ChatQuotaGate =
  | { ok: true; used: number; quota: number }
  | { ok: false; used: number; quota: number; upgradeUrl: string };

export async function checkChatQuota(client: PoolClient, tenant: TenantRow): Promise<ChatQuotaGate> {
  const used = await getChatsUsedUtcMonth(client, tenant.id);
  const quota = await getMonthlyChatQuotaForTenant(client, tenant);
  if (used >= quota) {
    return {
      ok: false,
      used,
      quota,
      upgradeUrl: buildDefaultUpgradeUrl(tenant.id),
    };
  }
  return { ok: true, used, quota };
}

export function buildDefaultUpgradeUrl(tenantId: string): string {
  const base = BILLING_UPGRADE_BASE_URL.trim();
  if (!base) {
    return '';
  }
  const u = new URL(base);
  u.searchParams.set('tenant', tenantId);
  return u.toString();
}

export type UpgradeUrls = {
  default: string;
  starter: string;
  growth: string;
  pro: string;
};

export function buildUpgradeUrls(tenantId: string): UpgradeUrls {
  const def = buildDefaultUpgradeUrl(tenantId);
  const withPlan = (slug: string, explicit: string): string => {
    const e = explicit.trim();
    if (e) {
      try {
        const u = new URL(e);
        u.searchParams.set('tenant', tenantId);
        return u.toString();
      } catch {
        return def;
      }
    }
    if (!BILLING_UPGRADE_BASE_URL.trim()) return '';
    const u = new URL(BILLING_UPGRADE_BASE_URL);
    u.searchParams.set('tenant', tenantId);
    u.searchParams.set('plan', slug);
    return u.toString();
  };
  return {
    default: def,
    starter: withPlan('starter', BILLING_URL_STARTER),
    growth: withPlan('growth', BILLING_URL_GROWTH),
    pro: withPlan('pro', BILLING_URL_PRO),
  };
}

export function getStripePriceIdForSlug(slug: 'starter' | 'growth' | 'pro'): string {
  const map = {
    starter: STRIPE_PRICE_STARTER,
    growth: STRIPE_PRICE_GROWTH,
    pro: STRIPE_PRICE_PRO,
  };
  return map[slug].trim();
}

export async function insertBillingEvent(
  client: PoolClient,
  tenantId: string | null,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(`INSERT INTO billing_events (tenant_id, event_type, payload) VALUES ($1, $2, $3)`, [
    tenantId,
    eventType,
    payload,
  ]);
}

export async function findTenantByStripeCustomerId(
  client: PoolClient,
  customerId: string
): Promise<TenantRow | null> {
  const r = await client.query<TenantRow>(
    `SELECT id, site_url, site_secret_hash, api_key_hash, embedding_provider, llm_provider,
            openai_key_ciphertext, kms_key_id,
            site_name, plugin_version, wp_version, wc_version, last_seen_at,
            stripe_customer_id, stripe_subscription_id, billing_plan_slug, subscription_status,
            current_period_end, billing_email, monthly_chat_quota_override
     FROM tenants WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  return r.rows[0] ?? null;
}

export async function updateTenantBillingFromStripe(
  client: PoolClient,
  tenantId: string,
  fields: {
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
    billing_plan_slug?: string | null;
    subscription_status?: string | null;
    current_period_end?: Date | null;
    billing_email?: string | null;
  }
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  let p = 1;
  if (fields.stripe_customer_id !== undefined) {
    sets.push(`stripe_customer_id = $${p++}`);
    vals.push(fields.stripe_customer_id);
  }
  if (fields.stripe_subscription_id !== undefined) {
    sets.push(`stripe_subscription_id = $${p++}`);
    vals.push(fields.stripe_subscription_id);
  }
  if (fields.billing_plan_slug !== undefined) {
    sets.push(`billing_plan_slug = $${p++}`);
    vals.push(fields.billing_plan_slug);
  }
  if (fields.subscription_status !== undefined) {
    sets.push(`subscription_status = $${p++}`);
    vals.push(fields.subscription_status);
  }
  if (fields.current_period_end !== undefined) {
    sets.push(`current_period_end = $${p++}`);
    vals.push(fields.current_period_end);
  }
  if (fields.billing_email !== undefined) {
    sets.push(`billing_email = $${p++}`);
    vals.push(fields.billing_email);
  }
  vals.push(tenantId);
  await client.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${p}`, vals);
}

export function isStripeCheckoutConfigured(): boolean {
  if (!STRIPE_SECRET_KEY.trim()) return false;
  return !!(
    STRIPE_PRICE_STARTER.trim() ||
    STRIPE_PRICE_GROWTH.trim() ||
    STRIPE_PRICE_PRO.trim()
  );
}

export async function getTenantBillingSnapshot(
  client: PoolClient,
  tenant: TenantRow
): Promise<{
  tenant_id: string;
  site_url: string;
  subscription_status: string | null;
  billing_plan_slug: string | null;
  current_period_end: string | null;
  used_chats_this_month: number;
  monthly_chat_quota: number;
  /** Set when an operator override is active; otherwise null. */
  monthly_chat_quota_override: number | null;
  upgrade_urls: UpgradeUrls;
  stripe_customer_id: string | null;
  stripe_checkout_enabled: boolean;
  max_indexed_products: number;
  indexed_product_count: number;
}> {
  const used = await getChatsUsedUtcMonth(client, tenant.id);
  const quota = await getMonthlyChatQuotaForTenant(client, tenant);
  const maxProd = await getMaxIndexedProductsForTenant(client, tenant);
  const indexedProd = await countDistinctIndexedProducts(client, tenant.id);
  const urls = buildUpgradeUrls(tenant.id);
  const ov = tenant.monthly_chat_quota_override;
  const overrideNorm =
    ov != null && Number.isFinite(Number(ov))
      ? Math.max(0, Math.min(50_000_000, Math.floor(Number(ov))))
      : null;
  return {
    tenant_id: tenant.id,
    site_url: tenant.site_url,
    subscription_status: tenant.subscription_status,
    billing_plan_slug: tenant.billing_plan_slug,
    current_period_end: tenant.current_period_end ? tenant.current_period_end.toISOString() : null,
    used_chats_this_month: used,
    monthly_chat_quota: quota,
    monthly_chat_quota_override: overrideNorm,
    upgrade_urls: urls,
    stripe_customer_id: tenant.stripe_customer_id,
    stripe_checkout_enabled: isStripeCheckoutConfigured(),
    max_indexed_products: maxProd,
    indexed_product_count: indexedProd,
  };
}

export async function resolvePlanSlugFromStripePriceId(
  client: PoolClient,
  priceId: string
): Promise<string | null> {
  if (!priceId) return null;
  const envMap: Record<string, string> = {};
  if (STRIPE_PRICE_STARTER.trim()) envMap[STRIPE_PRICE_STARTER.trim()] = 'starter';
  if (STRIPE_PRICE_GROWTH.trim()) envMap[STRIPE_PRICE_GROWTH.trim()] = 'growth';
  if (STRIPE_PRICE_PRO.trim()) envMap[STRIPE_PRICE_PRO.trim()] = 'pro';
  if (envMap[priceId]) return envMap[priceId];

  const r = await client.query<{ slug: string }>(
    `SELECT slug FROM billing_plans WHERE stripe_price_id = $1 AND active = TRUE`,
    [priceId]
  );
  return r.rows[0]?.slug ?? null;
}
