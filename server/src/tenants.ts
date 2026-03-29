import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { sha256Hex, randomApiKey } from './cryptoUtil.js';
import type { TenantMetadataInput } from './tenantMetadata.js';

export type EmbeddingProvider = 'openai';
export type LlmProvider = 'openai';

export interface TenantRow {
  id: string;
  site_url: string;
  site_secret_hash: string;
  api_key_hash: string;
  embedding_provider: EmbeddingProvider;
  llm_provider: LlmProvider;
  openai_key_ciphertext: Buffer | null;
  kms_key_id: string | null;
  site_name: string | null;
  plugin_version: string | null;
  wp_version: string | null;
  wc_version: string | null;
  last_seen_at: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_plan_slug: string | null;
  subscription_status: string | null;
  current_period_end: Date | null;
  billing_email: string | null;
  /** When set, `getMonthlyChatQuotaForTenant` uses this instead of plan / free tier. */
  monthly_chat_quota_override: number | null;
}

export async function findTenantByApiKey(
  client: pg.PoolClient,
  apiKey: string
): Promise<TenantRow | null> {
  const hash = sha256Hex(apiKey);
  const r = await client.query<TenantRow>(
    `SELECT id, site_url, site_secret_hash, api_key_hash, embedding_provider, llm_provider,
            openai_key_ciphertext, kms_key_id,
            site_name, plugin_version, wp_version, wc_version, last_seen_at,
            stripe_customer_id, stripe_subscription_id, billing_plan_slug, subscription_status,
            current_period_end, billing_email, monthly_chat_quota_override
     FROM tenants WHERE api_key_hash = $1 LIMIT 1`,
    [hash]
  );
  return r.rows[0] ?? null;
}

export async function findTenantById(client: pg.PoolClient, id: string): Promise<TenantRow | null> {
  const r = await client.query<TenantRow>(
    `SELECT id, site_url, site_secret_hash, api_key_hash, embedding_provider, llm_provider,
            openai_key_ciphertext, kms_key_id,
            site_name, plugin_version, wp_version, wc_version, last_seen_at,
            stripe_customer_id, stripe_subscription_id, billing_plan_slug, subscription_status,
            current_period_end, billing_email, monthly_chat_quota_override
     FROM tenants WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rows[0] ?? null;
}

export async function findTenantBySiteUrl(
  client: pg.PoolClient,
  siteUrl: string
): Promise<TenantRow | null> {
  const r = await client.query<TenantRow>(
    `SELECT id, site_url, site_secret_hash, api_key_hash, embedding_provider, llm_provider,
            openai_key_ciphertext, kms_key_id,
            site_name, plugin_version, wp_version, wc_version, last_seen_at,
            stripe_customer_id, stripe_subscription_id, billing_plan_slug, subscription_status,
            current_period_end, billing_email, monthly_chat_quota_override
     FROM tenants WHERE site_url = $1 LIMIT 1`,
    [siteUrl]
  );
  return r.rows[0] ?? null;
}

export interface RegisterResult {
  tenant_id: string;
  api_key: string;
}

function metaColumns(m: TenantMetadataInput | undefined): {
  site_name: string | null;
  plugin_version: string | null;
  wp_version: string | null;
  wc_version: string | null;
} {
  return {
    site_name: m?.site_name ?? null,
    plugin_version: m?.plugin_version ?? null,
    wp_version: m?.wp_version ?? null,
    wc_version: m?.wc_version ?? null,
  };
}

/**
 * All tenants use the shared OpenAI key on the server; per-tenant keys are not stored.
 */
export async function registerTenant(
  client: pg.PoolClient,
  params: {
    site_url: string;
    site_secret: string;
    metadata?: TenantMetadataInput;
  }
): Promise<RegisterResult> {
  const siteSecretHash = sha256Hex(params.site_secret);
  const existing = await findTenantBySiteUrl(client, params.site_url);
  const meta = metaColumns(params.metadata);

  if (existing) {
    if (existing.site_secret_hash !== siteSecretHash) {
      throw new Error('invalid_site_secret');
    }
    const apiKey = randomApiKey();
    const apiKeyHash = sha256Hex(apiKey);

    const metaFragments: string[] = [];
    const metaValues: unknown[] = [];
    // $1 = id (WHERE), $2 = api_key_hash; metadata columns use $3, $4, … (must stay consecutive for node-pg).
    let p = 3;
    if (params.metadata) {
      if (meta.site_name !== null) {
        metaFragments.push(`site_name = $${p++}`);
        metaValues.push(meta.site_name);
      }
      if (meta.plugin_version !== null) {
        metaFragments.push(`plugin_version = $${p++}`);
        metaValues.push(meta.plugin_version);
      }
      if (meta.wp_version !== null) {
        metaFragments.push(`wp_version = $${p++}`);
        metaValues.push(meta.wp_version);
      }
      if (meta.wc_version !== null) {
        metaFragments.push(`wc_version = $${p++}`);
        metaValues.push(meta.wc_version);
      }
    }
    const extraMeta = metaFragments.length > 0 ? `, ${metaFragments.join(', ')}` : '';

    await client.query(
      `UPDATE tenants SET api_key_hash = $2,
              embedding_provider = 'openai',
              llm_provider = 'openai',
              openai_key_ciphertext = NULL,
              kms_key_id = NULL,
              updated_at = NOW(),
              last_seen_at = NOW()
              ${extraMeta}
       WHERE id = $1`,
      [existing.id, apiKeyHash, ...metaValues]
    );
    return { tenant_id: existing.id, api_key: apiKey };
  }

  const id = randomUUID();
  const apiKey = randomApiKey();
  const apiKeyHash = sha256Hex(apiKey);

  await client.query(
    `INSERT INTO tenants (id, site_url, site_secret_hash, api_key_hash, embedding_provider, llm_provider,
            openai_key_ciphertext, kms_key_id, site_name, plugin_version, wp_version, wc_version, last_seen_at)
     VALUES ($1, $2, $3, $4, 'openai', 'openai', NULL, NULL, $5, $6, $7, $8, NOW())`,
    [
      id,
      params.site_url,
      siteSecretHash,
      apiKeyHash,
      meta.site_name ?? null,
      meta.plugin_version ?? null,
      meta.wp_version ?? null,
      meta.wc_version ?? null,
    ]
  );

  return { tenant_id: id, api_key: apiKey };
}

/** Updates profile fields from heartbeat; does not rotate API keys. */
export async function updateTenantMetadata(
  client: pg.PoolClient,
  tenantId: string,
  metadata: TenantMetadataInput
): Promise<void> {
  const meta = metaColumns(metadata);
  const fragments: string[] = [];
  const values: unknown[] = [];
  let p = 2;
  if (meta.site_name !== null) {
    fragments.push(`site_name = $${p++}`);
    values.push(meta.site_name);
  }
  if (meta.plugin_version !== null) {
    fragments.push(`plugin_version = $${p++}`);
    values.push(meta.plugin_version);
  }
  if (meta.wp_version !== null) {
    fragments.push(`wp_version = $${p++}`);
    values.push(meta.wp_version);
  }
  if (meta.wc_version !== null) {
    fragments.push(`wc_version = $${p++}`);
    values.push(meta.wc_version);
  }
  if (fragments.length === 0) {
    await client.query(`UPDATE tenants SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [
      tenantId,
    ]);
    return;
  }
  await client.query(
    `UPDATE tenants SET ${fragments.join(', ')}, last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [tenantId, ...values]
  );
}
