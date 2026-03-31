import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { isStripeCheckoutConfigured } from './billingRepo.js';
import {
  ADMIN_API_KEY,
  AWS_REGION,
  DB_URL,
  FREE_TIER_MAX_INDEXED_PRODUCTS,
  FREE_TIER_MONTHLY_CHATS,
  KMS_KEY_ID,
  OPENAI_API_URL,
  OPENAI_CHAT_MODEL,
  OPENAI_EMBEDDING_MODEL,
  SERVICE_VERSION,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersionSync(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export type TenantListRow = {
  id: string;
  site_url: string;
  site_name: string | null;
  embedding_provider: string;
  llm_provider: string;
  plugin_version: string | null;
  wp_version: string | null;
  wc_version: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  subscription_status: string | null;
  billing_plan_slug: string | null;
  stripe_customer_id: string | null;
  chats_utc_month: number;
  /** Effective quota (override or plan / free tier). */
  monthly_chat_quota: number;
  /** Operator override; null means use plan default. */
  monthly_chat_quota_override: number | null;
  chats_30d: number;
  ingests_30d: number;
  embed_tokens_30d: number;
  chat_prompt_tokens_30d: number;
  chat_completion_tokens_30d: number;
  indexed_product_count: number;
  /** 0 = unlimited */
  max_indexed_products: number;
};

function searchClause(): string {
  return `($1::text = ''
    OR strpos(lower(t.site_url), lower($1::text)) > 0
    OR strpos(lower(coalesce(t.site_name, '')), lower($1::text)) > 0)`;
}

export async function countTenantsMatching(client: PoolClient, search: string): Promise<number> {
  const q = search.trim();
  const r = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tenants t WHERE ${searchClause()}`,
    [q]
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function fetchTenantsPage(
  client: PoolClient,
  opts: { limit: number; offset: number; search: string }
): Promise<TenantListRow[]> {
  const q = opts.search.trim();
  const r = await client.query<{
    id: string;
    site_url: string;
    site_name: string | null;
    embedding_provider: string;
    llm_provider: string;
    plugin_version: string | null;
    wp_version: string | null;
    wc_version: string | null;
    created_at: Date;
    updated_at: Date;
    last_seen_at: Date | null;
    subscription_status: string | null;
    billing_plan_slug: string | null;
    stripe_customer_id: string | null;
    chats_utc_month: string;
    monthly_chat_quota: string;
    chats_30d: string;
    ingests_30d: string;
    embed_tokens_30d: string;
    chat_prompt_tokens_30d: string;
    chat_completion_tokens_30d: string;
    monthly_chat_quota_override: number | null;
    indexed_product_count: string;
    max_indexed_products: string;
  }>(
    `SELECT t.id, t.site_url, t.site_name, t.embedding_provider, t.llm_provider,
            t.plugin_version, t.wp_version, t.wc_version,
            t.created_at, t.updated_at, t.last_seen_at,
            t.subscription_status, t.billing_plan_slug, t.stripe_customer_id,
            COALESCE(um.chats, 0)::text AS chats_utc_month,
            t.monthly_chat_quota_override,
            (COALESCE(t.monthly_chat_quota_override,
              CASE
                WHEN lower(coalesce(t.subscription_status, '')) IN ('active', 'trialing')
                  AND t.billing_plan_slug IS NOT NULL
                  AND bp.monthly_chat_limit IS NOT NULL
                THEN bp.monthly_chat_limit
                ELSE $4::int
              END))::text AS monthly_chat_quota,
            (CASE
               WHEN lower(coalesce(t.subscription_status, '')) IN ('active', 'trialing')
                 AND t.billing_plan_slug IS NOT NULL
                 AND bp.max_indexed_products IS NOT NULL
               THEN bp.max_indexed_products
               ELSE $5::int
             END)::text AS max_indexed_products,
            COALESCE(pc.pc, 0)::text AS indexed_product_count,
            COALESCE(agg.chats, 0)::text AS chats_30d,
            COALESCE(agg.ingests, 0)::text AS ingests_30d,
            COALESCE(agg.embed_tokens, 0)::text AS embed_tokens_30d,
            COALESCE(agg.chat_prompt_tokens, 0)::text AS chat_prompt_tokens_30d,
            COALESCE(agg.chat_completion_tokens, 0)::text AS chat_completion_tokens_30d
     FROM tenants t
     LEFT JOIN billing_plans bp ON bp.slug = t.billing_plan_slug AND bp.active = TRUE
     LEFT JOIN (
       SELECT tenant_id, COUNT(DISTINCT external_id)::bigint AS pc
       FROM chunks
       WHERE source_type = 'product'
         AND external_id <> ''
         AND emb_openai IS NOT NULL
       GROUP BY tenant_id
     ) pc ON pc.tenant_id = t.id
     LEFT JOIN (
       SELECT tenant_id, SUM(chat_count)::bigint AS chats
       FROM usage_daily
       WHERE day >= date_trunc('month', timezone('utc', now()))::date
         AND day <= (timezone('utc', now()))::date
       GROUP BY tenant_id
     ) um ON um.tenant_id = t.id
     LEFT JOIN (
       SELECT tenant_id,
              SUM(chat_count)::bigint AS chats,
              SUM(ingest_request_count)::bigint AS ingests,
              SUM(embed_tokens)::bigint AS embed_tokens,
              SUM(chat_prompt_tokens)::bigint AS chat_prompt_tokens,
              SUM(chat_completion_tokens)::bigint AS chat_completion_tokens
       FROM usage_daily
       WHERE day >= (now() AT TIME ZONE 'utc')::date - 30
       GROUP BY tenant_id
     ) agg ON agg.tenant_id = t.id
     WHERE ${searchClause()}
     ORDER BY t.created_at DESC
     LIMIT $2 OFFSET $3`,
    [q, opts.limit, opts.offset, FREE_TIER_MONTHLY_CHATS, FREE_TIER_MAX_INDEXED_PRODUCTS]
  );
  return r.rows.map((row) => mapTenantListRow(row));
}

type TenantListQueryRow = {
  id: string;
  site_url: string;
  site_name: string | null;
  embedding_provider: string;
  llm_provider: string;
  plugin_version: string | null;
  wp_version: string | null;
  wc_version: string | null;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date | null;
  subscription_status: string | null;
  billing_plan_slug: string | null;
  stripe_customer_id: string | null;
  chats_utc_month: string;
  monthly_chat_quota: string;
  chats_30d: string;
  ingests_30d: string;
  embed_tokens_30d: string;
  chat_prompt_tokens_30d: string;
  chat_completion_tokens_30d: string;
  monthly_chat_quota_override: number | null;
  indexed_product_count: string;
  max_indexed_products: string;
};

function mapTenantListRow(row: TenantListQueryRow): TenantListRow {
  return {
    id: row.id,
    site_url: row.site_url,
    site_name: row.site_name,
    embedding_provider: row.embedding_provider,
    llm_provider: row.llm_provider,
    plugin_version: row.plugin_version,
    wp_version: row.wp_version,
    wc_version: row.wc_version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    subscription_status: row.subscription_status,
    billing_plan_slug: row.billing_plan_slug,
    stripe_customer_id: row.stripe_customer_id,
    chats_utc_month: Number(row.chats_utc_month),
    monthly_chat_quota: Number(row.monthly_chat_quota),
    monthly_chat_quota_override:
      row.monthly_chat_quota_override == null ? null : Number(row.monthly_chat_quota_override),
    chats_30d: Number(row.chats_30d),
    ingests_30d: Number(row.ingests_30d),
    embed_tokens_30d: Number(row.embed_tokens_30d),
    chat_prompt_tokens_30d: Number(row.chat_prompt_tokens_30d),
    chat_completion_tokens_30d: Number(row.chat_completion_tokens_30d),
    indexed_product_count: Number(row.indexed_product_count),
    max_indexed_products: Number(row.max_indexed_products),
  };
}

export async function fetchTenantListRowById(
  client: PoolClient,
  tenantId: string
): Promise<TenantListRow | null> {
  const r = await client.query<TenantListQueryRow>(
    `SELECT t.id, t.site_url, t.site_name, t.embedding_provider, t.llm_provider,
            t.plugin_version, t.wp_version, t.wc_version,
            t.created_at, t.updated_at, t.last_seen_at,
            t.subscription_status, t.billing_plan_slug, t.stripe_customer_id,
            COALESCE(um.chats, 0)::text AS chats_utc_month,
            t.monthly_chat_quota_override,
            (COALESCE(t.monthly_chat_quota_override,
              CASE
                WHEN lower(coalesce(t.subscription_status, '')) IN ('active', 'trialing')
                  AND t.billing_plan_slug IS NOT NULL
                  AND bp.monthly_chat_limit IS NOT NULL
                THEN bp.monthly_chat_limit
                ELSE $2::int
              END))::text AS monthly_chat_quota,
            (CASE
               WHEN lower(coalesce(t.subscription_status, '')) IN ('active', 'trialing')
                 AND t.billing_plan_slug IS NOT NULL
                 AND bp.max_indexed_products IS NOT NULL
               THEN bp.max_indexed_products
               ELSE $3::int
             END)::text AS max_indexed_products,
            COALESCE(pc.pc, 0)::text AS indexed_product_count,
            COALESCE(agg.chats, 0)::text AS chats_30d,
            COALESCE(agg.ingests, 0)::text AS ingests_30d,
            COALESCE(agg.embed_tokens, 0)::text AS embed_tokens_30d,
            COALESCE(agg.chat_prompt_tokens, 0)::text AS chat_prompt_tokens_30d,
            COALESCE(agg.chat_completion_tokens, 0)::text AS chat_completion_tokens_30d
     FROM tenants t
     LEFT JOIN billing_plans bp ON bp.slug = t.billing_plan_slug AND bp.active = TRUE
     LEFT JOIN (
       SELECT tenant_id, COUNT(DISTINCT external_id)::bigint AS pc
       FROM chunks
       WHERE source_type = 'product'
         AND external_id <> ''
         AND emb_openai IS NOT NULL
       GROUP BY tenant_id
     ) pc ON pc.tenant_id = t.id
     LEFT JOIN (
       SELECT tenant_id, SUM(chat_count)::bigint AS chats
       FROM usage_daily
       WHERE day >= date_trunc('month', timezone('utc', now()))::date
         AND day <= (timezone('utc', now()))::date
       GROUP BY tenant_id
     ) um ON um.tenant_id = t.id
     LEFT JOIN (
       SELECT tenant_id,
              SUM(chat_count)::bigint AS chats,
              SUM(ingest_request_count)::bigint AS ingests,
              SUM(embed_tokens)::bigint AS embed_tokens,
              SUM(chat_prompt_tokens)::bigint AS chat_prompt_tokens,
              SUM(chat_completion_tokens)::bigint AS chat_completion_tokens
       FROM usage_daily
       WHERE day >= (now() AT TIME ZONE 'utc')::date - 30
       GROUP BY tenant_id
     ) agg ON agg.tenant_id = t.id
     WHERE t.id = $1::uuid
     LIMIT 1`,
    [tenantId, FREE_TIER_MONTHLY_CHATS, FREE_TIER_MAX_INDEXED_PRODUCTS]
  );
  const row = r.rows[0];
  return row ? mapTenantListRow(row) : null;
}

export type AdminConfigSnapshot = {
  admin_panel_enabled: boolean;
  database_configured: boolean;
  aws_region: string;
  openai_chat_model: string;
  openai_embedding_model: string;
  kms_configured: boolean;
  openai_api_host: string;
  service_version: string;
  stripe_checkout_enabled: boolean;
};

const MAX_CHAT_QUOTA_OVERRIDE = 50_000_000;

/**
 * Set or clear operator monthly chat quota override. Returns false if tenant id not found.
 */
export async function updateTenantChatQuotaOverride(
  client: PoolClient,
  tenantId: string,
  override: number | null
): Promise<boolean> {
  const r = await client.query(
    `UPDATE tenants SET monthly_chat_quota_override = $2, updated_at = NOW() WHERE id = $1`,
    [tenantId, override]
  );
  return (r.rowCount ?? 0) > 0;
}

export function clampChatQuotaOverride(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_CHAT_QUOTA_OVERRIDE, Math.floor(n));
}

export function getAdminConfigSnapshot(): AdminConfigSnapshot {
  let openaiHost = 'api.openai.com';
  try {
    openaiHost = new URL(OPENAI_API_URL).host;
  } catch {
    /* keep default */
  }
  return {
    admin_panel_enabled: ADMIN_API_KEY.trim().length > 0,
    database_configured: DB_URL.trim().length > 0,
    aws_region: AWS_REGION,
    openai_chat_model: OPENAI_CHAT_MODEL,
    openai_embedding_model: OPENAI_EMBEDDING_MODEL,
    kms_configured: KMS_KEY_ID.trim().length > 0,
    openai_api_host: openaiHost,
    service_version: SERVICE_VERSION.trim() || readVersionSync(),
    stripe_checkout_enabled: isStripeCheckoutConfigured(),
  };
}
