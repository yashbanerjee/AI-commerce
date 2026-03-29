# Deploying the AI Ebot server (API)

## Database migrations

After pulling new code or before starting the API against a database, apply migrations:

```bash
cd server
npm install
npm run build
node dist/migrate.js
```

`migrate` runs every `*.sql` file in [`migrations/`](migrations/) in lexical order (e.g. `001_init.sql`, then `002_usage_and_metadata.sql`). Safe to re-run: statements use `IF NOT EXISTS` where appropriate.

In Docker (example):

```bash
docker compose exec api node dist/migrate.js
```

Use the service name and path that match your compose file.

## Usage metrics time zone

Daily rollups in `usage_daily.day` use the **UTC calendar date** at the time of each event (`(now() AT TIME ZONE 'utc')::date` in SQL). Monthly active user counts in [`/v1/admin/metrics/summary`](src/metricsRepo.ts) use UTC month boundaries via `timezone('utc', now())`.

## Admin metrics API

Set `ADMIN_API_KEY` in the environment to a long random secret, then:

```http
GET /v1/admin/metrics/summary?top=10
Authorization: Bearer <ADMIN_API_KEY>
```

If `ADMIN_API_KEY` is unset, the endpoint returns `401`.

## Operator web console

After `npm run build`, static assets live under `dist/admin/public`. Open:

- **`/admin/`** — browser UI for metrics, tenant search, per-tenant **chat quota override** (Apply / Default), **Tiers** (plan limits and Stripe price placeholders), per-tenant **tier assignment** and **indexed product** counts, and read-only service configuration.

Sign in with the same value as `ADMIN_API_KEY` (stored only in the browser session storage). Public **`GET /v1/admin/status`** reports whether `ADMIN_API_KEY` is set (no secret).

Additional JSON APIs (Bearer `ADMIN_API_KEY`):

- `GET /v1/admin/config` — models, region, flags (no secrets).
- `GET /v1/admin/tenants?limit=25&offset=0&q=` — paginated tenant list with 30-day chat/ingest rollups, effective quota / override fields, **indexed product count**, and **effective max indexed products** (tier / free).
- `PATCH /v1/admin/tenants/:tenantId/chat-quota` — JSON `{ "monthly_chat_quota_override": <number> }` sets a manual monthly chat limit for that tenant; `{ "monthly_chat_quota_override": null }` clears the override (plan / free tier applies again). Requires migration `005_tenant_chat_quota_override.sql`.
- `GET /v1/admin/billing-plans` — lists **`billing_plans`** rows plus **`free_tier_max_indexed_products`** / **`free_tier_monthly_chats`** (from env on the API).
- `PUT /v1/admin/billing-plans/:slug` — create or update a tier (`monthly_chat_limit`, `max_indexed_products` where **0 = unlimited**, `sort_order`, `active`, optional `stripe_price_id` for future Stripe). Slug pattern: `^[a-z][a-z0-9_-]{1,48}$`. Requires migration **`006_index_limits.sql`**.
- `PATCH /v1/admin/tenants/:tenantId/billing` — JSON `{ "billing_plan_slug": "<slug>" | null, "subscription_status": "<optional>" }` assigns a paid tier or **`null`** for free defaults (clears subscription when slug is null).

Set **`SERVICE_VERSION`** in Lambda if the version label should not rely on reading `package.json` from disk.

## Billing (Stripe)

1. Set **`STRIPE_SECRET_KEY`**, **`STRIPE_WEBHOOK_SECRET`**, and **`STRIPE_PRICE_STARTER`**, **`STRIPE_PRICE_GROWTH`**, **`STRIPE_PRICE_PRO`** (Price IDs from the Stripe Dashboard). Optionally set **`BILLING_UPGRADE_BASE_URL`** so quota errors include an **`upgrade_url`** for storefront users.
2. Register the webhook endpoint **`POST /v1/billing/webhook`** in Stripe (same base URL as the API). The server expects the **raw JSON body** for signature verification — when using API Gateway + Lambda, ensure the integration passes the **unmodified body** (see Stripe’s docs for your integration).
3. **`POST /v1/billing/create-checkout-session`** (Bearer tenant API key) accepts JSON `{ "plan": "starter" | "growth" | "pro" }` and returns `{ "url": "<Stripe Checkout URL>" }`.
4. **`GET /v1/tenant/billing`** (Bearer) returns usage, quota, and upgrade URLs for the WordPress admin or tooling.

Free tier: **`FREE_TIER_MONTHLY_CHATS`** (default 50) per tenant per **UTC calendar month**, enforced on **`POST /v1/chat`** before the LLM runs. Paid limits come from the **`billing_plans`** table (seeded `starter` / `growth` / `pro`) when **`subscription_status`** is `active` or `trialing`. If **`tenants.monthly_chat_quota_override`** is set (operator console or API), that value replaces the computed limit until cleared.

**Product index caps:** **`FREE_TIER_MAX_INDEXED_PRODUCTS`** (default **20**) applies to tenants **without** an active paid plan assignment. **`billing_plans.max_indexed_products`** applies when the tenant has **`billing_plan_slug`** set and **`subscription_status`** is `active` or `trialing`; **`0`** means **unlimited** distinct indexed products. Ingest skips **new** products beyond the cap (updates to already-indexed SKUs still apply). The WordPress plugin can **reindex in the background** via WP-Cron for large catalogs.

**`GET /v1/tenant/billing`** includes **`monthly_chat_quota`** (effective limit) and **`monthly_chat_quota_override`** (null unless an override is active).
