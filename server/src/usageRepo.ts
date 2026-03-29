import type { PoolClient } from 'pg';

export type UsageDelta = {
  chat?: number;
  ingestRequest?: number;
  indexedItems?: number;
  heartbeat?: number;
  /** Sum of OpenAI embedding prompt/total tokens (per request). */
  embedTokens?: number;
  /** Chat completion prompt tokens. */
  chatPromptTokens?: number;
  /** Chat completion completion tokens. */
  chatCompletionTokens?: number;
};

/**
 * Rolls up usage for the current UTC calendar day and sets tenants.last_seen_at.
 * All deltas default to 0 when omitted.
 */
export async function recordUsageAndTouch(
  client: PoolClient,
  tenantId: string,
  delta: UsageDelta
): Promise<void> {
  const chat = delta.chat ?? 0;
  const ingestRequest = delta.ingestRequest ?? 0;
  const indexedItems = delta.indexedItems ?? 0;
  const heartbeat = delta.heartbeat ?? 0;
  const embedTokens = delta.embedTokens ?? 0;
  const chatPromptTokens = delta.chatPromptTokens ?? 0;
  const chatCompletionTokens = delta.chatCompletionTokens ?? 0;

  if (
    chat === 0 &&
    ingestRequest === 0 &&
    indexedItems === 0 &&
    heartbeat === 0 &&
    embedTokens === 0 &&
    chatPromptTokens === 0 &&
    chatCompletionTokens === 0
  ) {
    await client.query(`UPDATE tenants SET last_seen_at = NOW() WHERE id = $1`, [tenantId]);
    return;
  }

  await client.query(
    `INSERT INTO usage_daily (tenant_id, day, chat_count, ingest_request_count, indexed_item_count, heartbeat_count,
            embed_tokens, chat_prompt_tokens, chat_completion_tokens)
     VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, day) DO UPDATE SET
       chat_count = usage_daily.chat_count + EXCLUDED.chat_count,
       ingest_request_count = usage_daily.ingest_request_count + EXCLUDED.ingest_request_count,
       indexed_item_count = usage_daily.indexed_item_count + EXCLUDED.indexed_item_count,
       heartbeat_count = usage_daily.heartbeat_count + EXCLUDED.heartbeat_count,
       embed_tokens = usage_daily.embed_tokens + EXCLUDED.embed_tokens,
       chat_prompt_tokens = usage_daily.chat_prompt_tokens + EXCLUDED.chat_prompt_tokens,
       chat_completion_tokens = usage_daily.chat_completion_tokens + EXCLUDED.chat_completion_tokens`,
    [
      tenantId,
      chat,
      ingestRequest,
      indexedItems,
      heartbeat,
      embedTokens,
      chatPromptTokens,
      chatCompletionTokens,
    ]
  );
  await client.query(`UPDATE tenants SET last_seen_at = NOW() WHERE id = $1`, [tenantId]);
}
