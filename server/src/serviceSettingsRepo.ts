import type { PoolClient } from 'pg';
import { decryptSecret, encryptSecret } from './secrets.js';

/**
 * Shared OpenAI key for all tenants: OPENAI_API_KEY env wins; else ciphertext in service_settings.
 */
export async function resolveOpenAiApiKey(client: PoolClient): Promise<string> {
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const r = await client.query<{ blob: Buffer | null }>(
    `SELECT openai_api_key_ciphertext AS blob FROM service_settings WHERE id = 1`
  );
  const blob = r.rows[0]?.blob ?? null;
  if (!blob) {
    throw new Error('openai_not_configured');
  }

  return decryptSecret(blob);
}

export async function upsertSharedOpenAiApiKey(client: PoolClient, plaintext: string): Promise<void> {
  const enc = await encryptSecret(plaintext);
  await client.query(
    `INSERT INTO service_settings (id, openai_api_key_ciphertext, kms_key_id, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       openai_api_key_ciphertext = EXCLUDED.openai_api_key_ciphertext,
       kms_key_id = EXCLUDED.kms_key_id,
       updated_at = NOW()`,
    [enc.blob, enc.kmsKeyId ?? null]
  );
}

export async function clearSharedOpenAiApiKey(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO service_settings (id, openai_api_key_ciphertext, kms_key_id, updated_at)
     VALUES (1, NULL, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET
       openai_api_key_ciphertext = NULL,
       kms_key_id = NULL,
       updated_at = NOW()`
  );
}

export type OpenAiKeySource = 'environment' | 'database' | 'none';

/** For admin dashboard: env key overrides stored key at runtime. */
export async function getOpenAiKeyStatus(client: PoolClient): Promise<{
  openai_api_configured: boolean;
  openai_api_key_source: OpenAiKeySource;
}> {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return { openai_api_configured: true, openai_api_key_source: 'environment' };
  }
  const r = await client.query<{ blob: Buffer | null }>(
    `SELECT openai_api_key_ciphertext AS blob FROM service_settings WHERE id = 1`
  );
  const blob = r.rows[0]?.blob ?? null;
  if (blob) {
    return { openai_api_configured: true, openai_api_key_source: 'database' };
  }
  return { openai_api_configured: false, openai_api_key_source: 'none' };
}
