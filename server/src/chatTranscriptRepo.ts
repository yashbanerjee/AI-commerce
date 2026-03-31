import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

const WP_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_TRANSCRIPT_CHARS = 200_000;

export function isValidWpSessionPublicId(id: string): boolean {
  return id !== '' && WP_SESSION_UUID_RE.test(id);
}

export function clampTranscriptText(s: string): string {
  if (s.length <= MAX_TRANSCRIPT_CHARS) {
    return s;
  }
  return `${s.slice(0, MAX_TRANSCRIPT_CHARS)}\n…(truncated)`;
}

export function newSessionPublicId(): string {
  return randomUUID();
}

export type ChatSessionRow = {
  id: string;
  public_id: string;
  shopper_wp_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export async function ensureChatSessionForTenant(
  client: PoolClient,
  tenantId: string,
  sessionPublicId: string,
  opts: { shopperWpUserId: number | null; ipHash: string | null }
): Promise<ChatSessionRow> {
  const uid =
    opts.shopperWpUserId !== null && opts.shopperWpUserId > 0 ? opts.shopperWpUserId : null;
  const ip = opts.ipHash !== null && opts.ipHash !== '' ? opts.ipHash : null;

  const r = await client.query<{
    id: string;
    public_id: string;
    shopper_wp_user_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO chat_sessions (tenant_id, public_id, shopper_wp_user_id, ip_hash, updated_at)
     VALUES ($1::uuid, $2, $3, $4, NOW())
     ON CONFLICT (tenant_id, public_id) DO UPDATE SET
       updated_at = NOW(),
       shopper_wp_user_id = COALESCE(EXCLUDED.shopper_wp_user_id, chat_sessions.shopper_wp_user_id),
       ip_hash = COALESCE(EXCLUDED.ip_hash, chat_sessions.ip_hash)
     RETURNING id, public_id, shopper_wp_user_id, created_at, updated_at`,
    [tenantId, sessionPublicId, uid, ip]
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error('session_upsert_failed');
  }
  return {
    id: row.id,
    public_id: row.public_id,
    shopper_wp_user_id: row.shopper_wp_user_id !== null ? Number(row.shopper_wp_user_id) : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function fetchChatSessionByPublicId(
  client: PoolClient,
  tenantId: string,
  sessionPublicId: string
): Promise<ChatSessionRow | null> {
  if (!isValidWpSessionPublicId(sessionPublicId)) {
    return null;
  }
  const r = await client.query<{
    id: string;
    public_id: string;
    shopper_wp_user_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, public_id, shopper_wp_user_id, created_at, updated_at
     FROM chat_sessions
     WHERE tenant_id = $1::uuid AND public_id = $2
     LIMIT 1`,
    [tenantId, sessionPublicId]
  );
  const row = r.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    public_id: row.public_id,
    shopper_wp_user_id: row.shopper_wp_user_id !== null ? Number(row.shopper_wp_user_id) : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Append one user + one assistant row (plain text). Session row must already exist. */
export async function appendUserAssistantTurn(
  client: PoolClient,
  sessionInternalUuid: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const u = clampTranscriptText(userMessage);
  const a = clampTranscriptText(assistantMessage);
  await client.query(
    `INSERT INTO chat_messages (session_id, role, content)
     VALUES ($1::uuid, 'user', $2), ($1::uuid, 'assistant', $3)`,
    [sessionInternalUuid, u, a]
  );
  await client.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1::uuid`, [
    sessionInternalUuid,
  ]);
}

export type ChatSessionListRow = {
  id: string;
  public_id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  shopper_wp_user_id: number | null;
};

export async function countChatSessionsForTenant(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM chat_sessions WHERE tenant_id = $1::uuid`,
    [tenantId]
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function listChatSessionsForTenant(
  client: PoolClient,
  tenantId: string,
  limit: number,
  offset: number
): Promise<ChatSessionListRow[]> {
  const r = await client.query<{
    id: string;
    public_id: string;
    created_at: Date;
    updated_at: Date;
    message_count: string;
    shopper_wp_user_id: string | null;
  }>(
    `SELECT s.id, s.public_id, s.created_at, s.updated_at, s.shopper_wp_user_id,
            (SELECT COUNT(*)::bigint FROM chat_messages m WHERE m.session_id = s.id)::text AS message_count
     FROM chat_sessions s
     WHERE s.tenant_id = $1::uuid
     ORDER BY s.updated_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return r.rows.map((row) => ({
    id: row.id,
    public_id: row.public_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    message_count: Number(row.message_count),
    shopper_wp_user_id:
      row.shopper_wp_user_id !== null ? Number(row.shopper_wp_user_id) : null,
  }));
}

export type ChatMessageRow = {
  role: string;
  content: string;
  created_at: string;
};

export async function verifySessionBelongsToTenant(
  client: PoolClient,
  tenantId: string,
  sessionUuid: string
): Promise<boolean> {
  const r = await client.query<{ x: number }>(
    `SELECT 1 AS x FROM chat_sessions WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [sessionUuid, tenantId]
  );
  return r.rows.length > 0;
}

export async function listMessagesForSession(
  client: PoolClient,
  sessionUuid: string,
  maxMessages: number
): Promise<ChatMessageRow[]> {
  const r = await client.query<{ role: string; content: string; created_at: Date }>(
    `SELECT role, content, created_at FROM chat_messages
     WHERE session_id = $1::uuid
     ORDER BY id ASC
     LIMIT $2`,
    [sessionUuid, maxMessages]
  );
  return r.rows.map((row) => ({
    role: row.role,
    content: row.content,
    created_at: row.created_at.toISOString(),
  }));
}

/**
 * Build OpenAI-style alternating user/assistant messages from stored rows (plain text only).
 * Skips malformed tails; keeps the last `maxPairs` complete pairs.
 */
export function buildOpenAiHistoryFromStoredMessages(
  rows: ChatMessageRow[],
  maxPairs: number
): { role: 'user' | 'assistant'; content: string }[] {
  const pairs: { u: string; a: string }[] = [];
  let i = 0;
  while (i + 1 < rows.length) {
    if (rows[i].role === 'user' && rows[i + 1].role === 'assistant') {
      pairs.push({ u: rows[i].content, a: rows[i + 1].content });
      i += 2;
    } else {
      i += 1;
    }
  }
  if (maxPairs <= 0) {
    return [];
  }
  const slice = pairs.slice(-maxPairs);
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const p of slice) {
    out.push({ role: 'user', content: p.u });
    out.push({ role: 'assistant', content: p.a });
  }
  return out;
}
