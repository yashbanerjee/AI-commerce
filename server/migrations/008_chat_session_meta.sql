-- Optional metadata for storefront sessions (WordPress user binding, IP hash for admin context).

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS shopper_wp_user_id INTEGER NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS ip_hash TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant_shopper
  ON chat_sessions (tenant_id, shopper_wp_user_id)
  WHERE shopper_wp_user_id IS NOT NULL;
