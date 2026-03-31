import type pg from 'pg';
import { randomUUID } from 'node:crypto';

export interface ChunkRow {
  id: string;
  external_id: string;
  source_type: string;
  source_id: string;
  url: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Set when reading from DB (search / fetch). */
  chunk_index?: number;
  distance?: number;
}

export function toVectorParam(values: number[] | null): string | null {
  if (!values?.length) return null;
  return `[${values.join(',')}]`;
}

export async function deleteChunksForExternals(
  client: pg.PoolClient,
  tenantId: string,
  externalIds: string[]
): Promise<void> {
  if (!externalIds.length) return;
  await client.query(`DELETE FROM chunks WHERE tenant_id = $1 AND external_id = ANY($2::text[])`, [
    tenantId,
    externalIds,
  ]);
}

export async function deleteAllChunks(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query(`DELETE FROM chunks WHERE tenant_id = $1`, [tenantId]);
}

export async function deleteChunksForExternal(
  client: pg.PoolClient,
  tenantId: string,
  externalId: string
): Promise<void> {
  await client.query(`DELETE FROM chunks WHERE tenant_id = $1 AND external_id = $2`, [tenantId, externalId]);
}

export async function insertChunk(client: pg.PoolClient, row: {
  tenant_id: string;
  external_id: string;
  chunk_index: number;
  source_type: string;
  source_id: string;
  url: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  emb_bedrock: number[] | null;
  emb_openai: number[] | null;
}): Promise<void> {
  const id = randomUUID();
  const vb = toVectorParam(row.emb_bedrock);
  const vo = toVectorParam(row.emb_openai);
  await client.query(
    `INSERT INTO chunks (id, tenant_id, external_id, chunk_index, source_type, source_id, url, title, content, emb_bedrock, emb_openai, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11::vector, $12::jsonb, NOW())`,
    [
      id,
      row.tenant_id,
      row.external_id,
      row.chunk_index,
      row.source_type,
      row.source_id,
      row.url,
      row.title,
      row.content,
      vb,
      vo,
      JSON.stringify(row.metadata),
    ]
  );
}

export async function searchChunks(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    openai?: number[];
    limit: number;
  }
): Promise<ChunkRow[]> {
  if (params.openai?.length) {
    const qv = toVectorParam(params.openai);
    const r = await client.query<ChunkRow>(
      `SELECT id::text, external_id, chunk_index, source_type, source_id, url, title, content, metadata,
              (emb_openai <=> $2::vector) AS distance
       FROM chunks
       WHERE tenant_id = $1 AND emb_openai IS NOT NULL
       ORDER BY emb_openai <=> $2::vector
       LIMIT $3`,
      [params.tenantId, qv, params.limit]
    );
    return r.rows;
  }
  return [];
}

/**
 * Load every stored chunk for the given sources (e.g. full product text after vector hits).
 */
/**
 * Distinct catalog products that have at least one embedded chunk (same set vector search can return).
 */
export async function countDistinctIndexedProducts(client: pg.PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ c: string }>(
    `SELECT COUNT(DISTINCT external_id)::text AS c
     FROM chunks
     WHERE tenant_id = $1
       AND source_type = 'product'
       AND external_id <> ''
       AND emb_openai IS NOT NULL`,
    [tenantId]
  );
  return Number(r.rows[0]?.c ?? 0);
}

export interface IndexedProductListRow {
  external_id: string;
  source_id: string;
  url: string;
  title: string;
  sku: string | null;
}

/**
 * Paginated list of distinct WooCommerce products present in the vector index (one row per external_id).
 */
export async function listIndexedProducts(
  client: pg.PoolClient,
  tenantId: string,
  limit: number,
  offset: number
): Promise<{ total: number; rows: IndexedProductListRow[] }> {
  const totalR = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM (
       SELECT DISTINCT external_id
       FROM chunks
       WHERE tenant_id = $1
         AND source_type = 'product'
         AND external_id <> ''
         AND emb_openai IS NOT NULL
     ) x`,
    [tenantId]
  );
  const total = Number(totalR.rows[0]?.c ?? 0);

  const r = await client.query<IndexedProductListRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (c.external_id)
         c.external_id,
         c.source_id,
         c.url,
         c.title,
         NULLIF(TRIM(COALESCE(c.metadata->>'sku', '')), '') AS sku
       FROM chunks c
       WHERE c.tenant_id = $1
         AND c.source_type = 'product'
         AND c.external_id <> ''
         AND c.emb_openai IS NOT NULL
       ORDER BY c.external_id, c.chunk_index ASC
     ) d
     ORDER BY LOWER(d.title) ASC NULLS LAST, d.external_id ASC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  return { total, rows: r.rows };
}

export interface IndexedPageListRow {
  external_id: string;
  source_id: string;
  url: string;
  title: string;
}

/**
 * Distinct WordPress pages in the index (external_id page:{id}), excluding site:info blobs.
 */
export async function listIndexedPages(
  client: pg.PoolClient,
  tenantId: string,
  limit: number,
  offset: number
): Promise<{ total: number; rows: IndexedPageListRow[] }> {
  const totalR = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM (
       SELECT DISTINCT external_id
       FROM chunks
       WHERE tenant_id = $1
         AND source_type = 'page'
         AND external_id LIKE 'page:%'
         AND emb_openai IS NOT NULL
     ) x`,
    [tenantId]
  );
  const total = Number(totalR.rows[0]?.c ?? 0);

  const r = await client.query<IndexedPageListRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (c.external_id)
         c.external_id,
         c.source_id,
         c.url,
         c.title
       FROM chunks c
       WHERE c.tenant_id = $1
         AND c.source_type = 'page'
         AND c.external_id LIKE 'page:%'
         AND c.emb_openai IS NOT NULL
       ORDER BY c.external_id, c.chunk_index ASC
     ) d
     ORDER BY LOWER(d.title) ASC NULLS LAST, d.external_id ASC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  return { total, rows: r.rows };
}

export async function tenantHasIndexedProduct(
  client: pg.PoolClient,
  tenantId: string,
  externalId: string
): Promise<boolean> {
  const r = await client.query<{ x: number }>(
    `SELECT 1 AS x FROM chunks
     WHERE tenant_id = $1 AND external_id = $2 AND source_type = 'product'
       AND emb_openai IS NOT NULL
     LIMIT 1`,
    [tenantId, externalId]
  );
  return r.rows.length > 0;
}

export async function fetchChunksForExternals(
  client: pg.PoolClient,
  tenantId: string,
  externalIds: string[]
): Promise<ChunkRow[]> {
  if (!externalIds.length) return [];
  const r = await client.query<ChunkRow>(
    `SELECT id::text, external_id, chunk_index, source_type, source_id, url, title, content, metadata
     FROM chunks
     WHERE tenant_id = $1 AND external_id = ANY($2::text[])
     ORDER BY external_id, chunk_index`,
    [tenantId, externalIds]
  );
  return r.rows;
}

/** Max characters of `content` returned per row (operator UI); remainder omitted with `content_truncated`. */
const ADMIN_CHUNK_CONTENT_CAP = 24_000;

export type AdminChunkListRow = {
  id: string;
  external_id: string;
  chunk_index: number;
  source_type: string;
  source_id: string;
  url: string;
  title: string;
  content: string;
  content_truncated: boolean;
  metadata: Record<string, unknown>;
  has_embedding: boolean;
  updated_at: string;
};

type AdminChunkQueryRow = {
  id: string;
  external_id: string;
  chunk_index: number;
  source_type: string;
  source_id: string;
  url: string;
  title: string;
  content: string;
  content_truncated: boolean;
  metadata: Record<string, unknown>;
  has_embedding: boolean;
  updated_at: Date;
};

function adminChunksWhereClause(): string {
  return `c.tenant_id = $1::uuid
     AND ($2::text = '' OR c.source_type = $2::text)
     AND (
       $3::text = ''
       OR position(lower($3::text) in lower(c.external_id)) > 0
       OR position(lower($3::text) in lower(c.title)) > 0
       OR position(lower($3::text) in lower(c.content)) > 0
     )`;
}

/**
 * Paginated chunk rows for operator review (text capped per row; no embedding vectors).
 */
export async function adminListChunksForTenant(
  client: pg.PoolClient,
  tenantId: string,
  opts: { limit: number; offset: number; sourceType: string; q: string }
): Promise<{ total: number; rows: AdminChunkListRow[] }> {
  const limit = opts.limit;
  const offset = opts.offset;
  const sourceType = opts.sourceType.trim();
  const q = opts.q.trim().slice(0, 240);

  const totalR = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM chunks c
     WHERE ${adminChunksWhereClause()}`,
    [tenantId, sourceType, q]
  );
  const total = Number(totalR.rows[0]?.c ?? 0);

  const cap = ADMIN_CHUNK_CONTENT_CAP;
  const r = await client.query<AdminChunkQueryRow>(
    `SELECT c.id::text,
            c.external_id,
            c.chunk_index,
            c.source_type,
            c.source_id,
            c.url,
            c.title,
            CASE
              WHEN length(c.content) > $6
              THEN substring(c.content from 1 for $6)
                || E'\n\n[truncated at ' || $6::text || ' characters; full length '
                || length(c.content)::text || ']'
              ELSE c.content
            END AS content,
            (length(c.content) > $6) AS content_truncated,
            c.metadata,
            (c.emb_openai IS NOT NULL) AS has_embedding,
            c.updated_at
     FROM chunks c
     WHERE ${adminChunksWhereClause()}
     ORDER BY c.source_type, c.external_id, c.chunk_index
     LIMIT $4 OFFSET $5`,
    [tenantId, sourceType, q, limit, offset, cap]
  );

  const rows: AdminChunkListRow[] = r.rows.map((row) => ({
    id: row.id,
    external_id: row.external_id,
    chunk_index: row.chunk_index,
    source_type: row.source_type,
    source_id: row.source_id,
    url: row.url,
    title: row.title,
    content: row.content,
    content_truncated: row.content_truncated,
    metadata: row.metadata ?? {},
    has_embedding: row.has_embedding,
    updated_at: row.updated_at.toISOString(),
  }));

  return { total, rows };
}
