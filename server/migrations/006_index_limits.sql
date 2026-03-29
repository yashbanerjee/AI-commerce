-- Per-tier caps on how many WooCommerce products may be indexed (source_type = 'product').
-- 0 = unlimited. Free tier uses server env FREE_TIER_MAX_INDEXED_PRODUCTS when tenant has no active plan.

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS max_indexed_products INT;

UPDATE billing_plans SET max_indexed_products = 500 WHERE slug = 'starter' AND max_indexed_products IS NULL;
UPDATE billing_plans SET max_indexed_products = 5000 WHERE slug = 'growth' AND max_indexed_products IS NULL;
UPDATE billing_plans SET max_indexed_products = 0 WHERE slug = 'pro' AND max_indexed_products IS NULL;
UPDATE billing_plans SET max_indexed_products = 20 WHERE max_indexed_products IS NULL;

ALTER TABLE billing_plans ALTER COLUMN max_indexed_products SET DEFAULT 20;
ALTER TABLE billing_plans ALTER COLUMN max_indexed_products SET NOT NULL;
