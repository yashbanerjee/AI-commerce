import { FREE_TIER_MAX_INDEXED_PRODUCTS, FREE_TIER_MONTHLY_CHATS } from './config.js';

/**
 * Default paid-tier limits match seeded rows in migrations/003_billing.sql and 006_index_limits.sql.
 * Operators can change live values via /admin (billing_plans).
 */
const TIER_DEFAULTS = {
  starter: { monthlyChats: 500, maxProducts: 500 },
  growth: { monthlyChats: 2500, maxProducts: 5000 },
  pro: { monthlyChats: 10000, maxProductsLabel: 'Unlimited' },
} as const;

export function renderLandingPageHtml(): string {
  const freeChats = FREE_TIER_MONTHLY_CHATS;
  const freeProducts = FREE_TIER_MAX_INDEXED_PRODUCTS;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Ebot — WooCommerce AI assistant API</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0c0f14;
      --bg-elevated: #141a24;
      --text: #e8ecf2;
      --muted: #8b95a8;
      --accent: #f0b429;
      --accent-dim: rgba(240, 180, 41, 0.15);
      --border: rgba(255, 255, 255, 0.08);
      --glow: rgba(240, 180, 41, 0.35);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: "DM Sans", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      font-optical-sizing: auto;
    }
    .noise {
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.04;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      z-index: 0;
    }
    .mesh {
      position: fixed;
      inset: 0;
      z-index: 0;
      background:
        radial-gradient(ellipse 80% 50% at 15% -10%, rgba(240, 180, 41, 0.12), transparent 55%),
        radial-gradient(ellipse 60% 40% at 100% 20%, rgba(100, 180, 255, 0.08), transparent 50%),
        radial-gradient(ellipse 50% 60% at 50% 100%, rgba(240, 100, 80, 0.06), transparent 45%);
      pointer-events: none;
    }
    .wrap {
      position: relative;
      z-index: 1;
      max-width: 1120px;
      margin: 0 auto;
      padding: 3rem 1.5rem 5rem;
    }
    h1, h2, h3 { font-family: Syne, sans-serif; font-weight: 700; letter-spacing: -0.02em; }
    .hero {
      margin-bottom: 4rem;
      animation: rise 0.9s ease-out both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(18px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .badge {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--accent);
      border: 1px solid var(--border);
      background: var(--accent-dim);
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      margin-bottom: 1.25rem;
    }
    .hero h1 {
      font-size: clamp(2.25rem, 5vw, 3.35rem);
      line-height: 1.1;
      margin-bottom: 1rem;
      max-width: 18ch;
    }
    .hero p.lead {
      font-size: 1.15rem;
      color: var(--muted);
      max-width: 42ch;
      margin-bottom: 1.75rem;
    }
    .hero-cta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
    }
    a.btn {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.65rem 1.25rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.95rem;
      text-decoration: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    a.btn:hover { transform: translateY(-1px); }
    a.btn-primary {
      background: var(--accent);
      color: #1a1408;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.2), 0 8px 28px var(--glow);
    }
    a.btn-ghost {
      border: 1px solid var(--border);
      color: var(--text);
      background: rgba(255,255,255,0.03);
    }
    a.btn-ghost:hover { border-color: rgba(255,255,255,0.2); }
    section { margin-bottom: 4rem; }
    section h2 {
      font-size: 1.65rem;
      margin-bottom: 1.5rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 1rem;
    }
    .feature {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.35rem;
      transition: border-color 0.2s ease;
    }
    .feature:hover { border-color: rgba(240, 180, 41, 0.25); }
    .feature h3 { font-size: 1.05rem; margin-bottom: 0.5rem; color: var(--text); }
    .feature p { font-size: 0.9rem; color: var(--muted); }
    .tiers {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
      align-items: stretch;
    }
    .tier {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
    }
    .tier.featured {
      border-color: rgba(240, 180, 41, 0.45);
      box-shadow: 0 0 40px rgba(240, 180, 41, 0.08);
    }
    .tier.featured::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), transparent);
    }
    .tier h3 { font-size: 1.2rem; margin-bottom: 0.35rem; text-transform: capitalize; }
    .tier .meta { font-size: 0.85rem; color: var(--muted); margin-bottom: 1rem; flex: 1; }
    .tier ul { list-style: none; font-size: 0.9rem; color: var(--muted); }
    .tier ul li {
      padding: 0.35rem 0;
      border-top: 1px solid var(--border);
    }
    .tier ul li:first-child { border-top: none; padding-top: 0; }
    .tier-label {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--accent);
      margin-bottom: 0.25rem;
    }
    .guide {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.75rem 1.5rem;
      counter-reset: step;
    }
    .guide ol { list-style: none; }
    .guide li {
      position: relative;
      padding-left: 3rem;
      margin-bottom: 1.35rem;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .guide li:last-child { margin-bottom: 0; }
    .guide li::before {
      counter-increment: step;
      content: counter(step);
      position: absolute;
      left: 0;
      top: 0;
      width: 2rem;
      height: 2rem;
      border-radius: 8px;
      background: var(--accent-dim);
      color: var(--accent);
      font-family: Syne, sans-serif;
      font-weight: 800;
      font-size: 0.9rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .guide strong { color: var(--text); font-weight: 600; }
    footer {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid var(--border);
      font-size: 0.85rem;
      color: var(--muted);
    }
    footer a { color: var(--accent); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    .footnote {
      font-size: 0.8rem;
      color: var(--muted);
      margin-top: 1rem;
      max-width: 65ch;
    }
    @media (prefers-reduced-motion: reduce) {
      .hero { animation: none; }
      a.btn:hover { transform: none; }
    }
  </style>
</head>
<body>
  <div class="mesh" aria-hidden="true"></div>
  <div class="noise" aria-hidden="true"></div>
  <div class="wrap">
    <header class="hero">
      <p class="badge">Hosted API for WooCommerce</p>
      <h1>AI Ebot turns your catalog into answers shoppers can trust.</h1>
      <p class="lead">Register your store, sync product text for retrieval, and power a storefront chat that stays on your facts — with usage limits and Stripe-ready tiers.</p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="#start">Quick start</a>
        <a class="btn btn-ghost" href="/admin/">Operator console</a>
        <a class="btn btn-ghost" href="/health">API health</a>
      </div>
    </header>

    <section id="features" aria-labelledby="features-heading">
      <h2 id="features-heading">Product capabilities</h2>
      <div class="features">
        <article class="feature">
          <h3>Store registration &amp; secure keys</h3>
          <p>Sites register over HTTPS and receive a tenant ID and Bearer token for all <code style="font-size:0.85em;color:var(--accent)">/v1/*</code> calls. Keys never live in the browser storefront beyond your WordPress integration.</p>
        </article>
        <article class="feature">
          <h3>Catalog ingest &amp; embeddings</h3>
          <p>Chunked product and page text is embedded for semantic search. Full reindex, partial updates, and caps per tier keep large catalogs under control.</p>
        </article>
        <article class="feature">
          <h3>Chat grounded in your catalog</h3>
          <p>Assistant replies use retrieved context, optional citations, follow-up suggestions, and rich product cards (title, URL, price, image) when relevant.</p>
        </article>
        <article class="feature">
          <h3>Usage &amp; quotas</h3>
          <p>Monthly chat limits roll up in UTC. Tenants see effective quota and usage via <code style="font-size:0.85em;color:var(--accent)">GET /v1/tenant/billing</code>; quota errors can include upgrade URLs.</p>
        </article>
        <article class="feature">
          <h3>Stripe billing</h3>
          <p><code style="font-size:0.85em;color:var(--accent)">POST /v1/billing/create-checkout-session</code> starts Checkout for <strong>starter</strong>, <strong>growth</strong>, or <strong>pro</strong>. Webhooks at <code style="font-size:0.85em;color:var(--accent)">/v1/billing/webhook</code> sync subscription state.</p>
        </article>
        <article class="feature">
          <h3>Operator admin</h3>
          <p>The <a href="/admin/" style="color:var(--accent)">/admin</a> console covers metrics, tenants, per-tenant overrides, and billing plan rows — when <code style="font-size:0.85em;color:var(--muted)">ADMIN_API_KEY</code> is configured.</p>
        </article>
        <article class="feature">
          <h3>Heartbeat &amp; observability</h3>
          <p>Plugins may send occasional admin heartbeat metadata. Use <code style="font-size:0.85em;color:var(--accent)">/health</code> for load balancers and uptime checks.</p>
        </article>
        <article class="feature">
          <h3>WordPress plugin</h3>
          <p>Pair this API with <strong>AI Ebot for WooCommerce</strong>: connect in wp-admin, reindex, then add the chat block or <code style="font-size:0.85em;color:var(--accent)">[ai_ebot_chat]</code> shortcode.</p>
        </article>
      </div>
    </section>

    <section id="tiers" aria-labelledby="tiers-heading">
      <h2 id="tiers-heading">Tiers &amp; limits</h2>
      <p class="footnote" style="margin-bottom:1.25rem">Free tier numbers below reflect <strong>this server’s</strong> environment. Paid tier defaults match the seeded database migration; operators can edit limits and Stripe price IDs in the admin console.</p>
      <div class="tiers">
        <div class="tier">
          <span class="tier-label">Included</span>
          <h3>Free</h3>
          <p class="meta">For sites without an active paid subscription (per UTC month).</p>
          <ul>
            <li><strong style="color:var(--text)">${freeChats}</strong> assistant chats / month</li>
            <li>Up to <strong style="color:var(--text)">${freeProducts}</strong> distinct products in the AI index</li>
          </ul>
        </div>
        <div class="tier">
          <span class="tier-label">Paid</span>
          <h3>Starter</h3>
          <p class="meta">Stripe Checkout with plan slug <code style="color:var(--accent)">starter</code>.</p>
          <ul>
            <li><strong style="color:var(--text)">${TIER_DEFAULTS.starter.monthlyChats}</strong> chats / month</li>
            <li>Up to <strong style="color:var(--text)">${TIER_DEFAULTS.starter.maxProducts}</strong> indexed products</li>
          </ul>
        </div>
        <div class="tier featured">
          <span class="tier-label">Paid</span>
          <h3>Growth</h3>
          <p class="meta">Best default for growing catalogs; slug <code style="color:var(--accent)">growth</code>.</p>
          <ul>
            <li><strong style="color:var(--text)">${TIER_DEFAULTS.growth.monthlyChats}</strong> chats / month</li>
            <li>Up to <strong style="color:var(--text)">${TIER_DEFAULTS.growth.maxProducts}</strong> indexed products</li>
          </ul>
        </div>
        <div class="tier">
          <span class="tier-label">Paid</span>
          <h3>Pro</h3>
          <p class="meta">Highest bundled chat volume; slug <code style="color:var(--accent)">pro</code>.</p>
          <ul>
            <li><strong style="color:var(--text)">${TIER_DEFAULTS.pro.monthlyChats}</strong> chats / month</li>
            <li><strong style="color:var(--text)">${TIER_DEFAULTS.pro.maxProductsLabel}</strong> indexed products (0 = unlimited in plan config)</li>
          </ul>
        </div>
      </div>
    </section>

    <section id="start" aria-labelledby="start-heading">
      <h2 id="start-heading">Quick start</h2>
      <div class="guide">
        <ol>
          <li><strong>Run the API.</strong> Point <code style="color:var(--accent)">DATABASE_URL</code> at Postgres, set <code style="color:var(--accent)">OPENAI_API_KEY</code> (or add the key later in <code style="color:var(--muted)">/admin</code>), and start the server so migrations apply.</li>
          <li><strong>Configure billing (optional).</strong> Add Stripe secrets and price IDs, register webhook <code style="color:var(--accent)">POST /v1/billing/webhook</code>, and set <code style="color:var(--muted)">BILLING_UPGRADE_BASE_URL</code> if you want upgrade links on quota errors.</li>
          <li><strong>Connect WordPress.</strong> Install AI Ebot for WooCommerce, set <code style="color:var(--muted)">AI_EBOT_SERVER_BASE_URL</code> in <code style="color:var(--muted)">wp-config.php</code> if needed, then complete <strong>Connection</strong> in wp-admin.</li>
          <li><strong>Index &amp; go live.</strong> Run a full reindex from the plugin overview, add the chat block or shortcode to a page, and monitor usage via <code style="color:var(--accent)">GET /v1/tenant/billing</code> or the operator console.</li>
        </ol>
      </div>
    </section>

    <footer>
      <p>AI Ebot API · JSON endpoints under <code style="color:var(--muted)">/v1/</code> · <a href="/admin/">Admin UI</a> · <a href="/health">Health</a></p>
    </footer>
  </div>
</body>
</html>`;
}
