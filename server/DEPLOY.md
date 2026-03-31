# Deploying the AI Ebot server (API)

## Database migrations

Schema is defined by SQL files in [`migrations/`](migrations/) (lexical order). Applied migrations are recorded in table **`schema_migrations`**; already-applied files are skipped.

**Production (`npm start`):** migrations run automatically before the HTTP server starts (`node dist/migrate.js && node dist/server.js`). Ensure **`DATABASE_URL`** points at your Postgres instance before the first boot.

**Manual run (local or debugging):**

```bash
cd server
npm install
npm run build
node dist/migrate.js
```

Older SQL uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` where possible; the ledger avoids re-executing whole files.

### Errors like `relation "tenants" does not exist`

The API was started against an empty database without applying migrations. Fix: set **`DATABASE_URL`**, redeploy (or run `node dist/migrate.js` once against that URL), then restart. On **Railway**, use the Postgres plugin’s variable and redeploy so `npm start` runs migrate.

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
- `GET /v1/admin/tenants/:tenantId` — tenant profile + usage rollups (same shape as list rows, plus cost estimate) and **`chat_sessions_total`**. Requires migrations **`007_chat_transcripts.sql`** and **`008_chat_session_meta.sql`** (optional metadata columns).
- `GET /v1/admin/tenants/:tenantId/chats?limit=&offset=` — paginated chat sessions (internal session UUID, public id, message count, timestamps).
- `GET /v1/admin/tenants/:tenantId/chats/:sessionId/messages` — full message thread for that session (operator review).
- `GET /v1/admin/tenants/:tenantId/chunks?limit=&offset=&source_type=&q=` — paginated **chunk** rows (indexed text, metadata, embedding flag); optional filters: `source_type` (`product`, `page`, …) and `q` (case-insensitive substring in external_id, title, or content). Operator UI lists these under each tenant.

Tenant (WordPress plugin) **`POST /v1/chat`** (Bearer) persists each turn on the API and returns **`session_id`**. **`GET /v1/chat/session/:publicId/messages?viewer_wp_user_id=`** loads storefront history (enforces WP user ownership when the session is bound to a logged-in customer). **`GET /v1/tenant/chat-sessions`** and **`GET /v1/tenant/chat-sessions/:publicId/messages`** power wp-admin session browsing.

Set **`SERVICE_VERSION`** in Lambda if the version label should not rely on reading `package.json` from disk.

## Billing (Stripe)

1. Set **`STRIPE_SECRET_KEY`**, **`STRIPE_WEBHOOK_SECRET`**, and **`STRIPE_PRICE_STARTER`**, **`STRIPE_PRICE_GROWTH`**, **`STRIPE_PRICE_PRO`** (Price IDs from the Stripe Dashboard). Optionally set **`BILLING_UPGRADE_BASE_URL`** so quota errors include an **`upgrade_url`** for storefront users.
2. Register the webhook endpoint **`POST /v1/billing/webhook`** in Stripe (same base URL as the API). The server expects the **raw JSON body** for signature verification — when using API Gateway + Lambda, ensure the integration passes the **unmodified body** (see Stripe’s docs for your integration).
3. **`POST /v1/billing/create-checkout-session`** (Bearer tenant API key) accepts JSON `{ "plan": "starter" | "growth" | "pro" }` and returns `{ "url": "<Stripe Checkout URL>" }`.
4. **`GET /v1/tenant/billing`** (Bearer) returns usage, quota, and upgrade URLs for the WordPress admin or tooling.

Free tier: **`FREE_TIER_MONTHLY_CHATS`** (default 50) per tenant per **UTC calendar month**, enforced on **`POST /v1/chat`** before the LLM runs. Paid limits come from the **`billing_plans`** table (seeded `starter` / `growth` / `pro`) when **`subscription_status`** is `active` or `trialing`. If **`tenants.monthly_chat_quota_override`** is set (operator console or API), that value replaces the computed limit until cleared.

**Product index caps:** **`FREE_TIER_MAX_INDEXED_PRODUCTS`** (default **20**) applies to tenants **without** an active paid plan assignment. **`billing_plans.max_indexed_products`** applies when the tenant has **`billing_plan_slug`** set and **`subscription_status`** is `active` or `trialing`; **`0`** means **unlimited** distinct indexed products. Ingest skips **new** products beyond the cap (updates to already-indexed SKUs still apply). The WordPress plugin can **reindex in the background** via WP-Cron for large catalogs.

**`GET /v1/tenant/billing`** includes **`monthly_chat_quota`** (effective limit) and **`monthly_chat_quota_override`** (null unless an override is active).

## Railway (and similar PaaS)

- **Root directory:** set the Railway service root to **`server/`** (this repo) so `package.json` and `migrations/` resolve correctly, or mirror the commands in [`railway.toml`](railway.toml).
- **Postgres:** add Railway **PostgreSQL** and ensure **`DATABASE_URL`** is attached to the API service. Enable the **`vector`** extension (pgvector); `001_init.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` (on managed Postgres this usually succeeds).
- **Start command:** `npm start` runs **`node dist/migrate.js`** then **`node dist/server.js`**. First deploy creates all tables; later deploys skip finished migrations via **`schema_migrations`**.
- **Listen address:** the server binds **`0.0.0.0`** by default so the reverse proxy can reach the process. If you override with **`HOST`**, use a value that accepts external connections.
- **Health check:** public **`GET /health`** should return **`200`** and JSON **`{"ok":true}`**. WordPress uses this for “Connection health”.
- **HTTP 502** from the public URL usually means the proxy cannot reach a healthy Node listener: check deploy logs for crashes (missing **`DATABASE_URL`**, **`OPENAI_API_KEY`**, failed migrations, etc.), wrong start command, or the service not listening on **`PORT`**.
