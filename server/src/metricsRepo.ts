import type { PoolClient } from 'pg';

export type MetricsSummary = {
  total_tenants: number;
  signups_last_7_days: number;
  signups_last_30_days: number;
  mau_current_month: number;
  tenants_seen_last_30_days: number;
  chats_last_30_days: number;
  ingests_last_30_days: number;
  embed_tokens_last_30_days: number;
  chat_prompt_tokens_last_30_days: number;
  chat_completion_tokens_last_30_days: number;
  top_tenants_by_chats: { tenant_id: string; site_url: string; site_name: string | null; chat_count: number }[];
};

export async function fetchMetricsSummary(
  client: PoolClient,
  topN: number
): Promise<MetricsSummary> {
  const total = await client.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tenants`);
  const s7 = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tenants WHERE created_at >= NOW() - INTERVAL '7 days'`
  );
  const s30 = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tenants WHERE created_at >= NOW() - INTERVAL '30 days'`
  );
  const mau = await client.query<{ c: string }>(
    `SELECT COUNT(DISTINCT tenant_id)::text AS c
     FROM usage_daily
     WHERE day >= date_trunc('month', timezone('utc', now()))::date
       AND day <= (timezone('utc', now()))::date
       AND (chat_count > 0 OR ingest_request_count > 0 OR heartbeat_count > 0)`
  );
  const seen = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM tenants WHERE last_seen_at >= NOW() - INTERVAL '30 days'`
  );
  const chats30 = await client.query<{ c: string }>(
    `SELECT COALESCE(SUM(chat_count), 0)::text AS c
     FROM usage_daily
     WHERE day >= (now() AT TIME ZONE 'utc')::date - 30`
  );
  const ing30 = await client.query<{ c: string }>(
    `SELECT COALESCE(SUM(ingest_request_count), 0)::text AS c
     FROM usage_daily
     WHERE day >= (now() AT TIME ZONE 'utc')::date - 30`
  );
  const emb30 = await client.query<{ c: string }>(
    `SELECT COALESCE(SUM(embed_tokens), 0)::text AS c
     FROM usage_daily
     WHERE day >= (now() AT TIME ZONE 'utc')::date - 30`
  );
  const cp30 = await client.query<{ c: string }>(
    `SELECT COALESCE(SUM(chat_prompt_tokens), 0)::text AS c
     FROM usage_daily
     WHERE day >= (now() AT TIME ZONE 'utc')::date - 30`
  );
  const cc30 = await client.query<{ c: string }>(
    `SELECT COALESCE(SUM(chat_completion_tokens), 0)::text AS c
     FROM usage_daily
     WHERE day >= (now() AT TIME ZONE 'utc')::date - 30`
  );
  const top = await client.query<{
    tenant_id: string;
    site_url: string;
    site_name: string | null;
    chat_count: string;
  }>(
    `SELECT t.id AS tenant_id, t.site_url, t.site_name,
            COALESCE(SUM(u.chat_count), 0)::text AS chat_count
     FROM tenants t
     LEFT JOIN usage_daily u ON u.tenant_id = t.id
       AND u.day >= (now() AT TIME ZONE 'utc')::date - 30
     GROUP BY t.id, t.site_url, t.site_name
     ORDER BY COALESCE(SUM(u.chat_count), 0) DESC
     LIMIT $1`,
    [topN]
  );

  return {
    total_tenants: Number(total.rows[0]?.c ?? 0),
    signups_last_7_days: Number(s7.rows[0]?.c ?? 0),
    signups_last_30_days: Number(s30.rows[0]?.c ?? 0),
    mau_current_month: Number(mau.rows[0]?.c ?? 0),
    tenants_seen_last_30_days: Number(seen.rows[0]?.c ?? 0),
    chats_last_30_days: Number(chats30.rows[0]?.c ?? 0),
    ingests_last_30_days: Number(ing30.rows[0]?.c ?? 0),
    embed_tokens_last_30_days: Number(emb30.rows[0]?.c ?? 0),
    chat_prompt_tokens_last_30_days: Number(cp30.rows[0]?.c ?? 0),
    chat_completion_tokens_last_30_days: Number(cc30.rows[0]?.c ?? 0),
    top_tenants_by_chats: top.rows.map((r) => ({
      tenant_id: r.tenant_id,
      site_url: r.site_url,
      site_name: r.site_name,
      chat_count: Number(r.chat_count),
    })),
  };
}
