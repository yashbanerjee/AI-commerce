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
/** Distinct WooCommerce products stored (source_type = product). */
export async function countDistinctIndexedProducts(client: pg.PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ c: string }>(
    `SELECT COUNT(DISTINCT external_id)::text AS c
     FROM chunks WHERE tenant_id = $1 AND source_type = 'product'`,
    [tenantId]
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function tenantHasIndexedProduct(
  client: pg.PoolClient,
  tenantId: string,
  externalId: string
): Promise<boolean> {
  const r = await client.query<{ x: number }>(
    `SELECT 1 AS x FROM chunks WHERE tenant_id = $1 AND external_id = $2 AND source_type = 'product' LIMIT 1`,
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
