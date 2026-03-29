-- Tenant profile + SaaS telemetry. Usage day buckets use UTC calendar date (see DEPLOY.md).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS site_name TEXT,
  ADD COLUMN IF NOT EXISTS plugin_version TEXT,
  ADD COLUMN IF NOT EXISTS wp_version TEXT,
  ADD COLUMN IF NOT EXISTS wc_version TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenants_last_seen ON tenants (last_seen_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  chat_count INT NOT NULL DEFAULT 0,
  ingest_request_count INT NOT NULL DEFAULT 0,
  indexed_item_count INT NOT NULL DEFAULT 0,
  heartbeat_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day);
