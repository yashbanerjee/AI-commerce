-- Operator override: when set, replaces plan/free-tier monthly chat limit for enforcement.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS monthly_chat_quota_override INT NULL;

COMMENT ON COLUMN tenants.monthly_chat_quota_override IS
  'If set, used as monthly chat quota instead of billing plan / free tier. NULL = use plan default.';
