import type { PoolClient } from 'pg';

export type BillingPlanAdminRow = {
  slug: string;
  stripe_price_id: string | null;
  monthly_chat_limit: number;
  max_indexed_products: number;
  sort_order: number;
  active: boolean;
};

export async function listBillingPlansAdmin(client: PoolClient): Promise<BillingPlanAdminRow[]> {
  const r = await client.query<{
    slug: string;
    stripe_price_id: string | null;
    monthly_chat_limit: string;
    max_indexed_products: string;
    sort_order: string;
    active: boolean;
  }>(
    `SELECT slug, stripe_price_id, monthly_chat_limit::text, max_indexed_products::text, sort_order::text, active
     FROM billing_plans
     ORDER BY sort_order ASC, slug ASC`
  );
  return r.rows.map((row) => ({
    slug: row.slug,
    stripe_price_id: row.stripe_price_id,
    monthly_chat_limit: Number(row.monthly_chat_limit),
    max_indexed_products: Number(row.max_indexed_products),
    sort_order: Number(row.sort_order),
    active: row.active,
  }));
}

export async function upsertBillingPlanAdmin(
  client: PoolClient,
  input: {
    slug: string;
    monthly_chat_limit: number;
    max_indexed_products: number;
    sort_order: number;
    active: boolean;
    stripe_price_id: string | null;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO billing_plans (slug, stripe_price_id, monthly_chat_limit, max_indexed_products, sort_order, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET
       stripe_price_id = EXCLUDED.stripe_price_id,
       monthly_chat_limit = EXCLUDED.monthly_chat_limit,
       max_indexed_products = EXCLUDED.max_indexed_products,
       sort_order = EXCLUDED.sort_order,
       active = EXCLUDED.active`,
    [
      input.slug,
      input.stripe_price_id,
      input.monthly_chat_limit,
      input.max_indexed_products,
      input.sort_order,
      input.active,
    ]
  );
}

export async function findBillingPlanBySlug(
  client: PoolClient,
  slug: string
): Promise<BillingPlanAdminRow | null> {
  const r = await client.query<{
    slug: string;
    stripe_price_id: string | null;
    monthly_chat_limit: string;
    max_indexed_products: string;
    sort_order: string;
    active: boolean;
  }>(
    `SELECT slug, stripe_price_id, monthly_chat_limit::text, max_indexed_products::text, sort_order::text, active
     FROM billing_plans WHERE slug = $1`,
    [slug]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    slug: row.slug,
    stripe_price_id: row.stripe_price_id,
    monthly_chat_limit: Number(row.monthly_chat_limit),
    max_indexed_products: Number(row.max_indexed_products),
    sort_order: Number(row.sort_order),
    active: row.active,
  };
}

export async function updateTenantBillingManual(
  client: PoolClient,
  tenantId: string,
  billing_plan_slug: string | null,
  subscription_status: string | null
): Promise<boolean> {
  const r = await client.query(
    `UPDATE tenants SET billing_plan_slug = $2, subscription_status = $3, updated_at = NOW() WHERE id = $1`,
    [tenantId, billing_plan_slug, subscription_status]
  );
  return (r.rowCount ?? 0) > 0;
}
