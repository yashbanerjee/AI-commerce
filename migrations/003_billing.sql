-- Stripe billing: plans, tenant subscription fields, audit log.

CREATE TABLE IF NOT EXISTS billing_plans (
  slug TEXT PRIMARY KEY,
  stripe_price_id TEXT,
  monthly_chat_limit INT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO billing_plans (slug, stripe_price_id, monthly_chat_limit, sort_order)
VALUES
  ('starter', NULL, 500, 1),
  ('growth', NULL, 2500, 2),
  ('pro', NULL, 10000, 3)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_plan_slug TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_email TEXT;

CREATE INDEX IF NOT EXISTS idx_tenants_stripe_customer ON tenants (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_tenants_stripe_subscription ON tenants (stripe_subscription_id);

CREATE TABLE IF NOT EXISTS billing_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON billing_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_created ON billing_events (created_at);
