/**
 * Operator console — uses sessionStorage for ADMIN_API_KEY only.
 */

const STORAGE_KEY = 'ai_ebot_admin_api_key';

function getBase() {
  return '';
}

function authHeaders() {
  const key = sessionStorage.getItem(STORAGE_KEY);
  const h = { Accept: 'application/json' };
  if (key) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

async function apiGet(path) {
  const res = await fetch(`${getBase()}${path}`, { headers: authHeaders() });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(typeof body?.error === 'string' ? body.error : res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function apiPost(path, jsonBody) {
  const res = await fetch(`${getBase()}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(jsonBody),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(typeof body?.error === 'string' ? body.error : res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function apiDelete(path) {
  const res = await fetch(`${getBase()}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(typeof body?.error === 'string' ? body.error : res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function apiPatch(path, jsonBody) {
  const res = await fetch(`${getBase()}${path}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(jsonBody),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(typeof body?.error === 'string' ? body.error : res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function apiPut(path, jsonBody) {
  const res = await fetch(`${getBase()}${path}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(jsonBody),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(typeof body?.error === 'string' ? body.error : res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function showLogin() {
  document.getElementById('view-login').classList.remove('hidden');
  document.getElementById('view-app').classList.add('hidden');
}

function showApp() {
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('view-app').classList.remove('hidden');
}

function setActiveTab(name) {
  document.querySelectorAll('.nav__item').forEach((el) => {
    el.classList.toggle('nav__item--active', el.dataset.tab === name);
  });
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('tab--active', el.id === `tab-${name}`);
    el.classList.toggle('hidden', el.id !== `tab-${name}`);
  });
  const titles = { dashboard: 'Dashboard', tenants: 'Tenants', tiers: 'Tiers', system: 'System' };
  document.getElementById('page-title').textContent = titles[name] ?? name;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function formatTs(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function formatUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const x = Number(n);
  if (x === 0) return '$0';
  if (Math.abs(x) < 0.01) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(2)}`;
}

function formatMaxIndexedCap(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  return x === 0 ? '∞' : String(Math.floor(x));
}

function tenantTierSelectOptions(currentSlug, plans) {
  const cur = currentSlug || '';
  const list = [...(plans || [])].sort((a, b) => {
    const so = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (so !== 0) return so;
    return String(a.slug).localeCompare(String(b.slug));
  });
  const opts = ['<option value="">Free (no plan)</option>'];
  for (const p of list) {
    const slug = p.slug || '';
    if (!p.active && slug !== cur) continue;
    const label = `${slug}${p.active ? '' : ' (inactive)'}`;
    const sel = slug === cur ? ' selected' : '';
    opts.push(`<option value="${esc(slug)}"${sel}>${esc(label)}</option>`);
  }
  return opts.join('');
}

async function loadStatus() {
  const warn = document.getElementById('login-warning');
  try {
    const s = await apiGet('/v1/admin/status');
    if (!s.admin_api_configured) {
      warn.textContent =
        'Server reports ADMIN_API_KEY is not set. Set it in the server environment, restart, then sign in.';
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
    }
  } catch {
    warn.textContent = 'Could not reach /v1/admin/status — check the API URL.';
    warn.classList.remove('hidden');
  }
}

async function loadDashboard() {
  const errEl = document.getElementById('dash-error');
  errEl.classList.add('hidden');
  try {
    const summary = await apiGet('/v1/admin/metrics/summary?top=15');
    const grid = document.getElementById('metrics-grid');
    const metrics = [
      ['Total tenants', summary.total_tenants],
      ['Signups (7d)', summary.signups_last_7_days],
      ['Signups (30d)', summary.signups_last_30_days],
      ['MAU (month)', summary.mau_current_month],
      ['Seen (30d)', summary.tenants_seen_last_30_days],
      ['Chats (30d)', summary.chats_last_30_days],
      ['Ingest requests (30d)', summary.ingests_last_30_days],
      ['Embed tokens (30d)', summary.embed_tokens_last_30_days],
      ['Chat prompt tokens (30d)', summary.chat_prompt_tokens_last_30_days],
      ['Chat completion tokens (30d)', summary.chat_completion_tokens_last_30_days],
      ['≈ OpenAI USD (30d)', formatUsd(summary.estimated_openai_usd_30d)],
    ];
    grid.innerHTML = metrics
      .map(
        ([label, val]) =>
          `<div class="metric"><div class="metric__value">${esc(String(val))}</div><div class="metric__label">${esc(label)}</div></div>`
      )
      .join('');

    const tbody = document.getElementById('table-top-body');
    const rows = summary.top_tenants_by_chats || [];
    tbody.innerHTML = rows
      .map((r) => {
        const name = r.site_name || '—';
        const url = r.site_url || '';
        return `<tr>
          <td>${esc(name)}</td>
          <td><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></td>
          <td class="num">${esc(String(r.chat_count))}</td>
        </tr>`;
      })
      .join('');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3">No data yet.</td></tr>';
    }
  } catch (e) {
    if (e.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      showLogin();
      const w = document.getElementById('login-warning');
      w.textContent = 'Invalid API key. Check ADMIN_API_KEY on the server.';
      w.classList.remove('hidden');
      throw e;
    }
    errEl.textContent = e.message || 'Failed to load metrics';
    errEl.classList.remove('hidden');
  }
}

let tenantOffset = 0;
const tenantPageSize = 25;
let tenantSearch = '';

async function loadTenants() {
  const errEl = document.getElementById('tenants-error');
  errEl.classList.add('hidden');
  try {
    const q = encodeURIComponent(tenantSearch);
    const [data, billingMeta] = await Promise.all([
      apiGet(`/v1/admin/tenants?limit=${tenantPageSize}&offset=${tenantOffset}&q=${q}`),
      apiGet('/v1/admin/billing-plans'),
    ]);
    const planList = billingMeta.plans || [];
    const tbody = document.getElementById('table-tenants-body');
    const rows = data.tenants || [];
    tbody.innerHTML = rows
      .map((t) => {
        const name = t.site_name || '—';
        const url = t.site_url || '';
        const plan = t.billing_plan_slug || '—';
        const sub = t.subscription_status || '—';
        const sc = t.stripe_customer_id
          ? `<a href="https://dashboard.stripe.com/customers/${esc(t.stripe_customer_id)}" target="_blank" rel="noopener" class="mono">${esc(t.stripe_customer_id.slice(0, 12))}…</a>`
          : '—';
        const embUsd = t.estimated_embed_usd_30d;
        const chatUsd = t.estimated_chat_usd_30d;
        const costTip =
          embUsd != null && chatUsd != null
            ? `Embed ${formatUsd(embUsd)} + chat ${formatUsd(chatUsd)}`
            : '';
        const ov = t.monthly_chat_quota_override;
        const ovVal =
          ov != null && Number.isFinite(Number(ov)) ? String(Math.floor(Number(ov))) : '';
        const clearDisabled = ovVal === '' ? ' disabled' : '';
        const idxCap = formatMaxIndexedCap(t.max_indexed_products);
        const tierOpts = tenantTierSelectOptions(t.billing_plan_slug, planList);
        return `<tr>
          <td>${esc(name)}</td>
          <td><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></td>
          <td class="mono">${esc(plan)}</td>
          <td class="mono">${esc(sub)}</td>
          <td class="num">${esc(String(t.chats_utc_month ?? 0))}</td>
          <td class="num">${esc(String(t.monthly_chat_quota ?? '—'))}</td>
          <td class="quota-override" data-tenant-id="${esc(t.id)}">
            <div class="quota-override__row">
              <input type="number" class="field__input quota-override__input" min="0" step="1" placeholder="plan" value="${esc(ovVal)}" aria-label="Monthly chat quota override" />
              <button type="button" class="btn btn--ghost btn--small" data-action="quota-apply">Apply</button>
              <button type="button" class="btn btn--ghost btn--small"${clearDisabled} data-action="quota-clear">Default</button>
            </div>
          </td>
          <td class="num mono" title="Distinct products in index / effective cap">${esc(String(t.indexed_product_count ?? 0))} / ${esc(idxCap)}</td>
          <td class="tier-assign" data-tenant-id="${esc(t.id)}">
            <div class="tier-assign__row">
              <select class="tier-assign__select" aria-label="Assign billing tier">${tierOpts}</select>
              <button type="button" class="btn btn--ghost btn--small" data-action="tier-apply">Apply</button>
            </div>
          </td>
          <td class="num">${esc(String(t.chats_30d))}</td>
          <td class="num">${esc(String(t.ingests_30d))}</td>
          <td class="num">${esc(String(t.embed_tokens_30d ?? 0))}</td>
          <td class="num">${esc(String(t.chat_prompt_tokens_30d ?? 0))}</td>
          <td class="num">${esc(String(t.chat_completion_tokens_30d ?? 0))}</td>
          <td class="num mono" title="${esc(costTip)}">${formatUsd(t.estimated_openai_usd_30d)}</td>
          <td>${esc(formatTs(t.last_seen_at))}</td>
          <td>${sc}</td>
          <td class="mono">${esc(t.id)}</td>
        </tr>`;
      })
      .join('');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="18">No tenants match.</td></tr>';
    }

    const total = data.total ?? 0;
    const start = total === 0 ? 0 : tenantOffset + 1;
    const end = Math.min(tenantOffset + rows.length, total);
    document.getElementById('pager-label').textContent =
      total === 0 ? '0 results' : `${start}–${end} of ${total}`;

    document.getElementById('pager-prev').disabled = tenantOffset <= 0;
    document.getElementById('pager-next').disabled = tenantOffset + tenantPageSize >= total;
  } catch (e) {
    errEl.textContent = e.message || 'Failed to load tenants';
    errEl.classList.remove('hidden');
  }
}

async function loadTiers() {
  const errEl = document.getElementById('tiers-error');
  errEl.classList.add('hidden');
  try {
    const d = await apiGet('/v1/admin/billing-plans');
    const freeLine = document.getElementById('tiers-free-line');
    freeLine.textContent = `Free tier defaults for tenants with no plan: ${d.free_tier_max_indexed_products} max indexed products; ${d.free_tier_monthly_chats} monthly chats (set FREE_TIER_MAX_INDEXED_PRODUCTS / FREE_TIER_MONTHLY_CHATS on the API).`;
    const note = document.getElementById('tiers-stripe-note');
    note.textContent = d.stripe_note || '';
    const tbody = document.getElementById('table-plans-body');
    const plans = d.plans || [];
    tbody.innerHTML = plans
      .map((p) => {
        const stripe = p.stripe_price_id ? esc(p.stripe_price_id) : '—';
        return `<tr>
          <td class="mono">${esc(p.slug)}</td>
          <td>${p.active ? 'Yes' : 'No'}</td>
          <td class="num">${esc(String(p.sort_order))}</td>
          <td class="num">${esc(String(p.monthly_chat_limit))}</td>
          <td class="num">${esc(formatMaxIndexedCap(p.max_indexed_products))}</td>
          <td class="mono" style="max-width:12rem;overflow:hidden;text-overflow:ellipsis" title="${stripe}">${stripe}</td>
          <td>
            <button type="button" class="btn btn--ghost btn--small" data-action="tier-plan-edit"
              data-slug="${esc(p.slug)}"
              data-active="${p.active ? '1' : '0'}"
              data-sort="${esc(String(p.sort_order))}"
              data-chats="${esc(String(p.monthly_chat_limit))}"
              data-indexed="${esc(String(p.max_indexed_products))}"
              data-stripe="${esc(p.stripe_price_id || '')}"
            >Edit</button>
          </td>
        </tr>`;
      })
      .join('');
    if (!plans.length) {
      tbody.innerHTML = '<tr><td colspan="7">No tiers yet. Add one below.</td></tr>';
    }
  } catch (e) {
    if (e.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      showLogin();
      const w = document.getElementById('login-warning');
      w.textContent = 'Invalid API key. Check ADMIN_API_KEY on the server.';
      w.classList.remove('hidden');
      throw e;
    }
    errEl.textContent = e.message || 'Failed to load tiers';
    errEl.classList.remove('hidden');
  }
}

async function loadSystem() {
  const errEl = document.getElementById('system-error');
  errEl.classList.add('hidden');
  try {
    const cfg = await apiGet('/v1/admin/config');
    const src = cfg.openai_api_key_source || 'none';
    const ok = cfg.openai_api_configured;
    const line = document.getElementById('openai-key-line');
    line.textContent = ok
      ? `Key configured — source: ${src} (environment overrides database when both exist).`
      : 'No shared OpenAI key: set OPENAI_API_KEY on the server or save a key below.';

    const grid = document.getElementById('system-config');
    const items = [
      ['Service version', cfg.service_version],
      ['AWS region', cfg.aws_region],
      ['OpenAI chat model', cfg.openai_chat_model],
      ['OpenAI embedding model', cfg.openai_embedding_model],
      ['OpenAI API host', cfg.openai_api_host],
      ['Database', cfg.database_configured ? 'Configured' : 'Missing'],
      ['KMS', cfg.kms_configured ? 'Configured' : 'Not set'],
      ['Admin API', cfg.admin_panel_enabled ? 'Enabled' : 'Disabled'],
      ['Stripe checkout (prices + secret)', cfg.stripe_checkout_enabled ? 'Ready' : 'Not configured'],
    ];
    grid.innerHTML = items
      .map(([k, v]) => {
        const ok = v === 'Configured' || v === 'Enabled';
        const cls =
          v === 'Not set' || v === 'Missing' || v === 'Disabled' ? 'config-item__v--off' : ok ? 'config-item__v--ok' : '';
        return `<div class="config-item"><div class="config-item__k">${esc(k)}</div><div class="config-item__v ${cls}">${esc(String(v))}</div></div>`;
      })
      .join('');

    let healthText = 'Checking…';
    try {
      const h = await fetch(`${getBase()}/health`);
      const j = await h.json();
      healthText = h.ok && j.ok ? 'GET /health — OK' : `GET /health — HTTP ${h.status}`;
    } catch {
      healthText = 'GET /health — unreachable';
    }
    document.getElementById('health-line').textContent = healthText;
  } catch (e) {
    errEl.textContent = e.message || 'Failed to load config';
    errEl.classList.remove('hidden');
  }
}

async function refreshCurrentTab() {
  const active = document.querySelector('.nav__item--active');
  const tab = active?.dataset.tab || 'dashboard';
  if (tab === 'dashboard') await loadDashboard();
  if (tab === 'tenants') await loadTenants();
  if (tab === 'tiers') await loadTiers();
  if (tab === 'system') await loadSystem();
}

document.getElementById('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) return;
  sessionStorage.setItem(STORAGE_KEY, key);
  document.getElementById('login-warning').classList.add('hidden');
  showApp();
  try {
    await loadDashboard();
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    showLogin();
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  sessionStorage.removeItem(STORAGE_KEY);
  showLogin();
  document.getElementById('api-key-input').value = '';
});

document.querySelectorAll('.nav__item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    setActiveTab(name);
    if (name === 'dashboard') loadDashboard();
    if (name === 'tenants') {
      tenantOffset = 0;
      loadTenants();
    }
    if (name === 'tiers') loadTiers();
    if (name === 'system') loadSystem();
  });
});

document.getElementById('btn-refresh').addEventListener('click', () => refreshCurrentTab());

document.getElementById('tenant-search-btn').addEventListener('click', () => {
  tenantSearch = document.getElementById('tenant-search').value;
  tenantOffset = 0;
  loadTenants();
});

document.getElementById('tenant-search').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    tenantSearch = ev.target.value;
    tenantOffset = 0;
    loadTenants();
  }
});

document.getElementById('pager-prev').addEventListener('click', () => {
  tenantOffset = Math.max(0, tenantOffset - tenantPageSize);
  loadTenants();
});

document.getElementById('pager-next').addEventListener('click', () => {
  tenantOffset += tenantPageSize;
  loadTenants();
});

document.getElementById('table-tenants-body').addEventListener('click', async (ev) => {
  const tierBtn = ev.target.closest('[data-action="tier-apply"]');
  if (tierBtn) {
    const cell = tierBtn.closest('[data-tenant-id]');
    if (!cell) return;
    const tenantId = cell.getAttribute('data-tenant-id');
    if (!tenantId) return;
    const sel = cell.querySelector('.tier-assign__select');
    const errEl = document.getElementById('tenants-error');
    errEl.classList.add('hidden');
    const raw = sel && sel.value != null ? String(sel.value).trim().toLowerCase() : '';
    try {
      await apiPatch(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/billing`, {
        billing_plan_slug: raw === '' ? null : raw,
      });
      await loadTenants();
    } catch (e) {
      if (e.status === 401) {
        sessionStorage.removeItem(STORAGE_KEY);
        showLogin();
        const w = document.getElementById('login-warning');
        w.textContent = 'Invalid API key. Check ADMIN_API_KEY on the server.';
        w.classList.remove('hidden');
        return;
      }
      const detail =
        e.body && typeof e.body.error === 'string'
          ? e.body.error
          : e.message || 'Request failed';
      errEl.textContent = detail;
      errEl.classList.remove('hidden');
    }
    return;
  }

  const btn = ev.target.closest('[data-action^="quota-"]');
  if (!btn) return;
  const cell = btn.closest('[data-tenant-id]');
  if (!cell) return;
  const tenantId = cell.getAttribute('data-tenant-id');
  if (!tenantId) return;
  const input = cell.querySelector('.quota-override__input');
  const errEl = document.getElementById('tenants-error');
  errEl.classList.add('hidden');
  const action = btn.getAttribute('data-action');
  try {
    if (action === 'quota-clear') {
      await apiPatch(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/chat-quota`, {
        monthly_chat_quota_override: null,
      });
    } else if (action === 'quota-apply') {
      const raw = (input && input.value ? String(input.value) : '').trim();
      if (!raw) {
        errEl.textContent = 'Enter a non-negative whole number for the monthly chat limit, or use Default.';
        errEl.classList.remove('hidden');
        return;
      }
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        errEl.textContent = 'Quota override must be a non-negative integer.';
        errEl.classList.remove('hidden');
        return;
      }
      await apiPatch(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/chat-quota`, {
        monthly_chat_quota_override: n,
      });
    } else {
      return;
    }
    await loadTenants();
  } catch (e) {
    if (e.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      showLogin();
      const w = document.getElementById('login-warning');
      w.textContent = 'Invalid API key. Check ADMIN_API_KEY on the server.';
      w.classList.remove('hidden');
      return;
    }
    const detail =
      e.body && typeof e.body.error === 'string'
        ? e.body.error
        : e.message || 'Request failed';
    errEl.textContent = detail;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('openai-key-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = document.getElementById('openai-key-input');
  const key = (input.value || '').trim();
  if (!key) return;
  const errEl = document.getElementById('system-error');
  errEl.classList.add('hidden');
  try {
    await apiPost('/v1/admin/settings/openai-key', { api_key: key });
    input.value = '';
    await loadSystem();
  } catch (e) {
    errEl.textContent = e.message || 'Failed to save key';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('table-plans-body').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-action="tier-plan-edit"]');
  if (!b) return;
  document.getElementById('tier-slug').value = (b.dataset.slug || '').trim();
  document.getElementById('tier-sort').value = b.dataset.sort || '0';
  document.getElementById('tier-active').checked = b.dataset.active === '1';
  document.getElementById('tier-chats').value = b.dataset.chats || '0';
  document.getElementById('tier-indexed').value = b.dataset.indexed || '0';
  document.getElementById('tier-stripe').value = b.dataset.stripe || '';
  document.getElementById('tier-slug').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

document.getElementById('tier-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const errEl = document.getElementById('tiers-error');
  errEl.classList.add('hidden');
  const slug = document.getElementById('tier-slug').value.trim().toLowerCase();
  if (!slug) {
    errEl.textContent = 'Enter a tier slug.';
    errEl.classList.remove('hidden');
    return;
  }
  const mcl = parseInt(document.getElementById('tier-chats').value, 10);
  const mip = parseInt(document.getElementById('tier-indexed').value, 10);
  const so = parseInt(document.getElementById('tier-sort').value, 10);
  if (!Number.isFinite(mcl) || mcl < 0) {
    errEl.textContent = 'Monthly chat limit must be a non-negative integer.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!Number.isFinite(mip) || mip < 0) {
    errEl.textContent = 'Max indexed products must be a non-negative integer (0 = unlimited).';
    errEl.classList.remove('hidden');
    return;
  }
  if (!Number.isFinite(so)) {
    errEl.textContent = 'Sort order must be a number.';
    errEl.classList.remove('hidden');
    return;
  }
  const stripeRaw = document.getElementById('tier-stripe').value.trim();
  try {
    await apiPut(`/v1/admin/billing-plans/${encodeURIComponent(slug)}`, {
      monthly_chat_limit: mcl,
      max_indexed_products: mip,
      sort_order: so,
      active: document.getElementById('tier-active').checked,
      stripe_price_id: stripeRaw === '' ? null : stripeRaw,
    });
    await loadTiers();
  } catch (e) {
    if (e.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      showLogin();
      const w = document.getElementById('login-warning');
      w.textContent = 'Invalid API key. Check ADMIN_API_KEY on the server.';
      w.classList.remove('hidden');
      return;
    }
    const detail =
      e.body && typeof e.body.error === 'string'
        ? e.body.error
        : e.message || 'Request failed';
    errEl.textContent = detail;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('openai-key-clear').addEventListener('click', async () => {
  const errEl = document.getElementById('system-error');
  errEl.classList.add('hidden');
  try {
    await apiDelete('/v1/admin/settings/openai-key');
    await loadSystem();
  } catch (e) {
    errEl.textContent = e.message || 'Failed to clear key';
    errEl.classList.remove('hidden');
  }
});

async function boot() {
  loadStatus();
  if (sessionStorage.getItem(STORAGE_KEY)) {
    showApp();
    try {
      await loadDashboard();
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
      showLogin();
    }
  } else {
    showLogin();
  }
}

boot();
