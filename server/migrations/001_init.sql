CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  site_url TEXT NOT NULL UNIQUE,
  site_secret_hash TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  embedding_provider TEXT NOT NULL DEFAULT 'bedrock',
  llm_provider TEXT NOT NULL DEFAULT 'bedrock',
  openai_key_ciphertext BYTEA,
  kms_key_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_api_key_hash ON tenants (api_key_hash);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  chunk_index INT NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  emb_bedrock vector(1024),
  emb_openai vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, external_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON chunks (tenant_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant_external ON chunks (tenant_id, external_id);

CREATE INDEX IF NOT EXISTS idx_chunks_emb_bedrock ON chunks USING ivfflat (emb_bedrock vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_chunks_emb_openai ON chunks USING ivfflat (emb_openai vector_cosine_ops) WITH (lists = 100);
