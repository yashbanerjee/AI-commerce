-- Single shared OpenAI key (env OPENAI_API_KEY and/or service_settings); per-tenant token usage.

CREATE TABLE IF NOT EXISTS service_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  openai_api_key_ciphertext BYTEA,
  kms_key_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One column per statement — easier to retry if a partial migration ran.
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS embed_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS chat_prompt_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS chat_completion_tokens BIGINT NOT NULL DEFAULT 0;

UPDATE tenants SET embedding_provider = 'openai', llm_provider = 'openai' WHERE true;
UPDATE tenants SET openai_key_ciphertext = NULL WHERE true;
