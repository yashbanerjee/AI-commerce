import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { withClient } from './db.js';
import {
  ADMIN_API_KEY,
  CHAT_COMPLETION_MAX_TOKENS,
  CHAT_COMPLETION_MAX_TOKENS_CATALOG,
  CHAT_PRODUCT_CARDS_MAX,
  FREE_TIER_MAX_INDEXED_PRODUCTS,
  FREE_TIER_MONTHLY_CHATS,
} from './config.js';
import {
  clampChatQuotaOverride,
  countTenantsMatching,
  fetchTenantsPage,
  getAdminConfigSnapshot,
  updateTenantChatQuotaOverride,
} from './adminRepo.js';
import {
  checkChatQuota,
  getMaxIndexedProductsForTenant,
  getTenantBillingSnapshot,
} from './billingRepo.js';
import { fetchMetricsSummary } from './metricsRepo.js';
import { estimateOpenAiCostUsd, openAiCostEstimateMeta } from './llmCostEstimate.js';
import {
  findTenantByApiKey,
  registerTenant,
  updateTenantMetadata,
} from './tenants.js';
import { chunkText } from './chunkText.js';
import {
  countDistinctIndexedProducts,
  deleteAllChunks,
  deleteChunksForExternals,
  deleteChunksForExternal,
  fetchChunksForExternals,
  insertChunk,
  searchChunks,
  tenantHasIndexedProduct,
  type ChunkRow,
} from './chunksRepo.js';
import { embedTextWithOpenAi } from './embeddings.js';
import { generateAnswerWithOpenAi } from './llm.js';
import { enrichProductCardsWithImages, extractImageFromMetadata } from './enrichProductCards.js';
import { parseTenantMetadata } from './tenantMetadata.js';
import { recordUsageAndTouch } from './usageRepo.js';
import {
  findBillingPlanBySlug,
  listBillingPlansAdmin,
  updateTenantBillingManual,
  upsertBillingPlanAdmin,
} from './plansAdminRepo.js';
import { resolveOpenAiApiKey, upsertSharedOpenAiApiKey, clearSharedOpenAiApiKey, getOpenAiKeyStatus } from './serviceSettingsRepo.js';

async function authTenant(client: PoolClient, req: Request) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  return findTenantByApiKey(client, m[1].trim());
}

function adminBearerAuthorized(req: Request): boolean {
  const key = ADMIN_API_KEY.trim();
  if (!key) return false;
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1].trim(), 'utf8');
  const b = Buffer.from(key, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Max vector hits loaded into chat CONTEXT (not total catalog size). */
const CHAT_RETRIEVAL_CHUNK_LIMIT = 14;

function sanitizeChatHistory(
  raw: unknown,
  maxMessages: number
): { role: 'user' | 'assistant'; content: string }[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: string }).role;
    const content = (item as { content?: string }).content;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    const c = content.trim().slice(0, 12000);
    if (!c) continue;
    out.push({ role, content: c });
  }
  return out.slice(-maxMessages);
}

/** Merge all chunk parts per product (vector search often returns only one slice of a long description). */
function mergeRetrievedChunks(hitRows: ChunkRow[], allForHits: ChunkRow[]): ChunkRow[] {
  const order = [...new Set(hitRows.map((h) => h.external_id))];
  const grouped = new Map<string, ChunkRow[]>();
  for (const r of allForHits) {
    if (!grouped.has(r.external_id)) grouped.set(r.external_id, []);
    grouped.get(r.external_id)!.push(r);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
  }
  const merged: ChunkRow[] = [];
  for (const extId of order) {
    const list = grouped.get(extId);
    if (!list?.length) continue;
    const head = { ...list[0] };
    head.content = list.map((x) => x.content).join('\n\n');
    merged.push(head);
  }
  return merged;
}

export async function handleRegister(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown> & {
      site_url?: string;
      site_secret?: string;
    };
    if (!body.site_url || !body.site_secret) {
      res.status(400).json({ error: 'site_url_and_site_secret_required' });
      return;
    }
    const metadata = parseTenantMetadata(body);

    const result = await withClient((c) =>
      registerTenant(c, {
        site_url: String(body.site_url),
        site_secret: String(body.site_secret),
        metadata,
      })
    );
    res.json({ tenant_id: result.tenant_id, api_key: result.api_key });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    if (msg === 'invalid_site_secret') {
      res.status(403).json({ error: msg });
      return;
    }
    res.status(500).json({ error: msg });
  }
}

export async function handleIngest(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      items?: unknown[];
      delete_external_ids?: string[];
      full_reindex?: boolean;
    };

    const count = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return {
          err: 401 as const,
          n: 0,
          indexed_product_count: 0,
          max_indexed_products: 0,
          skipped_products: 0,
        };
      }

      if (body.full_reindex) {
        await deleteAllChunks(c, tenant.id);
      }
      if (body.delete_external_ids?.length) {
        await deleteChunksForExternals(c, tenant.id, body.delete_external_ids);
      }

      const apiKey = await resolveOpenAiApiKey(c);
      const maxProducts = await getMaxIndexedProductsForTenant(c, tenant);
      const unlimited = maxProducts <= 0;
      let runningDistinct = await countDistinctIndexedProducts(c, tenant.id);

      const items = Array.isArray(body.items) ? body.items : [];
      let n = 0;
      let embedTokens = 0;
      let skippedProducts = 0;
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const it = raw as Record<string, unknown>;
        const external_id = String(it.external_id ?? '');
        const text = String(it.text ?? '');
        if (!external_id || !text) continue;

        const sourceType = String(it.source_type ?? 'custom');
        const isProduct = sourceType === 'product';

        let countNewProductSlot = false;
        if (isProduct) {
          const hadBefore = await tenantHasIndexedProduct(c, tenant.id, external_id);
          if (!hadBefore) {
            if (!unlimited && runningDistinct >= maxProducts) {
              skippedProducts++;
              continue;
            }
            countNewProductSlot = true;
          }
        }

        await deleteChunksForExternal(c, tenant.id, external_id);
        const parts = chunkText(text);
        let idx = 0;
        for (const part of parts) {
          const emb = await embedTextWithOpenAi(part.text, apiKey);
          embedTokens += emb.promptTokens;
          await insertChunk(c, {
            tenant_id: tenant.id,
            external_id,
            chunk_index: idx++,
            source_type: sourceType,
            source_id: String(it.source_id ?? ''),
            url: String(it.url ?? ''),
            title: String(it.title ?? ''),
            content: part.text,
            metadata: (it.metadata && typeof it.metadata === 'object' ? it.metadata : {}) as Record<
              string,
              unknown
            >,
            emb_bedrock: null,
            emb_openai: emb.embedding,
          });
        }
        n += 1;
        if (countNewProductSlot) {
          runningDistinct++;
        }
      }
      // Fix increment: track wasNew from before delete
      await recordUsageAndTouch(c, tenant.id, {
        ingestRequest: 1,
        indexedItems: n,
        embedTokens,
      });
      const indexed_product_count = await countDistinctIndexedProducts(c, tenant.id);
      return {
        err: null,
        n,
        indexed_product_count,
        max_indexed_products: maxProducts,
        skipped_products: skippedProducts,
      };
    });

    if (count.err === 401) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    res.json({
      ok: true,
      indexed: count.n,
      indexed_product_count: count.indexed_product_count,
      max_indexed_products: count.max_indexed_products,
      skipped_products: count.skipped_products,
      products_capped: count.skipped_products > 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    if (msg === 'openai_not_configured') {
      res.status(503).json({ error: msg });
      return;
    }
    res.status(500).json({ error: msg });
  }
}

function parsePublishedProductsFromChatBody(body: Record<string, unknown>): number | null {
  const raw = body.published_products;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 50_000_000) return null;
  return Math.floor(n);
}

export async function handleChat(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      message?: string;
      tone?: string;
      history?: { role: string; content: string }[];
      strict_grounding?: boolean;
      published_products?: unknown;
      catalog_context?: unknown;
    };
    const message = String(body.message ?? '').trim();
    if (!message) {
      res.status(400).json({ error: 'message_required' });
      return;
    }
    const publishedProducts = parsePublishedProductsFromChatBody(body as Record<string, unknown>);
    const catalogRaw = body.catalog_context;
    const catalogContext =
      typeof catalogRaw === 'string' && catalogRaw.trim() !== '' ? catalogRaw.trim().slice(0, 1_400_000) : '';
    const hasCatalogOutline = catalogContext.length > 0;

    const result = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return { kind: 'unauth' as const };
      }

      const gate = await checkChatQuota(c, tenant);
      if (!gate.ok) {
        return { kind: 'quota' as const, gate };
      }

      const apiKey = await resolveOpenAiApiKey(c);
      const [qEmb, indexedDistinct, maxIndexed] = await Promise.all([
        embedTextWithOpenAi(message, apiKey),
        countDistinctIndexedProducts(c, tenant.id),
        getMaxIndexedProductsForTenant(c, tenant),
      ]);
      const embedTokens = qEmb.promptTokens;

      const hits = await searchChunks(c, {
        tenantId: tenant.id,
        openai: qEmb.embedding,
        limit: CHAT_RETRIEVAL_CHUNK_LIMIT,
      });
      const hitIds = [...new Set(hits.map((h) => h.external_id))];
      const allChunks = await fetchChunksForExternals(c, tenant.id, hitIds);
      const rows = mergeRetrievedChunks(hits, allChunks);

      const contextBlocks = rows.map((r, i) => {
        const img = extractImageFromMetadata(r.metadata);
        const imgPart = img ? ` image=${img}` : '';
        return `[#${i + 1}] title=${r.title} url=${r.url} type=${r.source_type}${imgPart}\n${r.content}`;
      });

      const tone = String(body.tone ?? '').trim();
      const strict = body.strict_grounding !== false;
      const history = sanitizeChatHistory(body.history, 16);

      // Put the live catalog count first when present — models often anchor on the first number.
      const storeCountLines: string[] = [];
      if (publishedProducts !== null) {
        storeCountLines.push(
          `Live WooCommerce catalog (use this for "how many products do you have / sell / carry in the shop", catalog size, or total listed products): ${publishedProducts} published product(s) (published parent and simple products; excludes drafts and excludes variations as separate product posts).`
        );
      }
      storeCountLines.push(
        `AI search index (distinct products with embeddings — used for retrieval; can be lower than the live catalog because of plan limits, reindex lag, or skipped items): ${indexedDistinct} product(s).`
      );
      if (maxIndexed > 0) {
        storeCountLines.push(
          `Under the current plan, at most ${maxIndexed} distinct product(s) can be stored in the AI search index (larger catalogs may be partially indexed).`
        );
      }
      if (publishedProducts !== null && publishedProducts > indexedDistinct) {
        storeCountLines.push(
          `Mandatory wording rule: If the shopper asks how many products the store has in total, you MUST lead with the live catalog figure (${publishedProducts}). You may briefly add that AI search currently covers ${indexedDistinct} product(s) if that sets expectations. You MUST NOT answer with only ${indexedDistinct} as the store's total product count.`
        );
      } else if (publishedProducts !== null && publishedProducts < indexedDistinct) {
        storeCountLines.push(
          'The index count is higher than the reported live catalog (unusual); mention both briefly or prefer the live catalog count if the shopper asks about storefront totals.'
        );
      } else if (publishedProducts === null) {
        storeCountLines.push(
          'No live catalog total was supplied by WordPress; use the index count for totals and clarify it is the search index, not a guaranteed live storefront count, if asked.'
        );
      }
      storeCountLines.push(
        `CONTEXT below is only a retrieval sample: at most ${CHAT_RETRIEVAL_CHUNK_LIMIT} vector matches, merged by item. It is not the catalog. Never use the number of CONTEXT blocks, nor the highest [#n] label, as the store's product count.`
      );

      const maxChatTokens = hasCatalogOutline
        ? CHAT_COMPLETION_MAX_TOKENS_CATALOG
        : CHAT_COMPLETION_MAX_TOKENS;

      const catalogBlock = hasCatalogOutline
        ? [
            '=== STORE CATALOG OUTLINE (from WooCommerce) ===',
            'The block below lists product categories, brands (when configured), and published products as markdown links. It is authoritative for: what you sell, list all products, categories, brands, store inventory overview, or similar browse-the-whole-shop questions.',
            'For those questions you MUST: include every category name from the outline; every brand name (or clearly state none were supplied); and every product line from the PRODUCTS section as a numbered markdown list using the titles and URLs given. Do not shorten to only a few items unless the outline itself is partial (then explain that).',
            'For follow-up questions about one product’s details, still use CONTEXT when it helps.',
            '',
            catalogContext,
            '=== END STORE CATALOG OUTLINE ===',
          ].join('\n')
        : '';

      const systemParts = [
        'You are a helpful storefront assistant.',
        catalogBlock,
        'Earlier messages in this chat (if any) are provided for continuity — use them to stay coherent and to tailor follow-ups.',
        tone ? `Tone and style: ${tone}` : '',
        storeCountLines.join(' '),
        'If the user only greets you or chats casually (e.g. hello, how are you) and CONTEXT is empty or not relevant, reply in one or two friendly sentences. Use citations: [].',
        strict
          ? 'For product facts (descriptions, price, SKU, stock, etc.), use CONTEXT when it mentions those products. For store-wide totals or "how many products", use the live catalog and index figures from this system message (never CONTEXT size or [#n] count). When both live catalog and index counts were given and they differ, inventory-style questions must use the live catalog number first. For each product the user asks about that appears in CONTEXT, include every relevant detail: full descriptions, short blurbs, price, SKU, stock, categories, tags, attributes, variations, dimensions, and weight when present. Quote or paraphrase those facts clearly; do not give only a one-line summary when CONTEXT contains more.'
          : 'Prefer the CONTEXT when relevant for product details; for store-wide product totals, follow the live catalog vs index rules above.',
        'Say you do not have a piece of information only when that specific fact does not appear anywhere in CONTEXT or the STORE CATALOG OUTLINE (when present). Do not refuse to give "more detail" when CONTEXT already includes descriptions or specs—extract and present them.',
        hasCatalogOutline
          ? 'When the shopper wants a full catalog-style list and a STORE CATALOG OUTLINE is present, build the full list from that outline (not from CONTEXT alone). Use a short intro sentence, then a numbered markdown list for products. List categories and brands in clear sections or sentences.'
          : 'When listing multiple products without a store outline, use a short friendly sentence, then a markdown numbered list: each line "1. [Product title](exact url from CONTEXT)" etc. Use **bold** sparingly for emphasis.',
        'Always add "suggestions": an array of 2–4 very short follow-up lines (max ~45 characters each) the shopper might tap next. They must logically follow YOUR answer and the conversation (e.g. shipping, returns, size guide, "show similar items", a specific product follow-up). Use [] only if no sensible options exist.',
        `Add "product_cards": up to ${CHAT_PRODUCT_CARDS_MAX} objects {"title":"","url":"","price_text":"","image_url":""}. Copy title, url, and image_url from CONTEXT or the catalog outline (image=… on CONTEXT lines when present). price_text if known, else "". For huge catalog listings, you may use [] if the answer already contains the full markdown list; otherwise a representative subset is OK.`,
        'Respond with exactly one JSON object (no markdown code fences). Required shape:',
        '{"answer":"…","citations":[{"title":"","url":"","source_type":"","id":""}],"suggestions":["…"],"product_cards":[{"title":"","url":"","price_text":"","image_url":""}]}',
        'Never paste instruction text into answer. For small talk, citations and product_cards can be empty arrays.',
      ].filter(Boolean);

      const system = systemParts.join('\n');
      const userContent = `CONTEXT (retrieval sample only — not every product):\n${contextBlocks.join('\n\n---\n\n')}\n\nCURRENT USER MESSAGE:\n${message}`;

      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: userContent },
      ];

      const out = await generateAnswerWithOpenAi(messages, apiKey, maxChatTokens);
      const product_cards = enrichProductCardsWithImages(out.product_cards, rows);
      await recordUsageAndTouch(c, tenant.id, {
        chat: 1,
        embedTokens,
        chatPromptTokens: out.promptTokens,
        chatCompletionTokens: out.completionTokens,
      });
      return { kind: 'ok' as const, out: { ...out, product_cards } };
    });

    if (result.kind === 'unauth') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (result.kind === 'quota') {
      res.status(402).json({
        error: 'chat_quota_exceeded',
        code: 'chat_quota_exceeded',
        used_chats_this_month: result.gate.used,
        monthly_chat_quota: result.gate.quota,
        upgrade_url: result.gate.upgradeUrl,
      });
      return;
    }

    res.json({
      answer: result.out.answer,
      citations: result.out.citations,
      suggestions: result.out.suggestions,
      product_cards: result.out.product_cards,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    if (msg === 'openai_not_configured') {
      res.status(503).json({ error: msg });
      return;
    }
    res.status(500).json({ error: msg });
  }
}

export async function handleTenantBilling(req: Request, res: Response): Promise<void> {
  try {
    const snap = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return null;
      }
      return getTenantBillingSnapshot(c, tenant);
    });
    if (!snap) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json(snap);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleHeartbeat(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const metadata = parseTenantMetadata(body);

    const unauthorized = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return true;
      }
      await updateTenantMetadata(c, tenant.id, metadata);
      await recordUsageAndTouch(c, tenant.id, { heartbeat: 1 });
      return false;
    });

    if (unauthorized) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminMetrics(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const raw = req.query.top;
    const topN = Math.min(50, Math.max(1, parseInt(String(raw ?? '10'), 10) || 10));
    const summary = await withClient((c) => fetchMetricsSummary(c, topN));
    const agg = estimateOpenAiCostUsd({
      embed_tokens: summary.embed_tokens_last_30_days,
      chat_prompt_tokens: summary.chat_prompt_tokens_last_30_days,
      chat_completion_tokens: summary.chat_completion_tokens_last_30_days,
    });
    res.json({
      ...summary,
      estimated_openai_usd_30d: agg.estimated_openai_usd_total,
      estimated_embed_usd_30d: agg.estimated_embed_usd,
      estimated_chat_usd_30d:
        agg.estimated_chat_input_usd + agg.estimated_chat_output_usd,
      cost_estimate: openAiCostEstimateMeta(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminStatus(_req: Request, res: Response): Promise<void> {
  res.json({
    ok: true,
    admin_api_configured: ADMIN_API_KEY.trim().length > 0,
  });
}

export async function handleAdminConfig(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const payload = await withClient(async (c) => ({
      ...getAdminConfigSnapshot(),
      ...(await getOpenAiKeyStatus(c)),
    }));
    res.json(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminSetOpenAiKey(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = req.body as { api_key?: string };
    const key = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    if (!key) {
      res.status(400).json({ error: 'api_key_required' });
      return;
    }
    await withClient((c) => upsertSharedOpenAiApiKey(c, key));
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminDeleteOpenAiKey(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    await withClient((c) => clearSharedOpenAiApiKey(c));
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminTenants(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const search = String(req.query.q ?? '');

    const payload = await withClient(async (c) => {
      const total = await countTenantsMatching(c, search);
      const tenants = await fetchTenantsPage(c, { limit, offset, search });
      return { total, tenants };
    });

    const tenantsWithCost = payload.tenants.map((t) => {
      const c = estimateOpenAiCostUsd({
        embed_tokens: t.embed_tokens_30d,
        chat_prompt_tokens: t.chat_prompt_tokens_30d,
        chat_completion_tokens: t.chat_completion_tokens_30d,
      });
      return {
        ...t,
        estimated_openai_usd_30d: c.estimated_openai_usd_total,
        estimated_embed_usd_30d: c.estimated_embed_usd,
        estimated_chat_usd_30d: c.estimated_chat_input_usd + c.estimated_chat_output_usd,
      };
    });

    res.json({
      total: payload.total,
      limit,
      offset,
      tenants: tenantsWithCost,
      cost_estimate: openAiCostEstimateMeta(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

const TENANT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleAdminTenantChatQuotaPatch(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const tenantId = String(req.params.tenantId ?? '');
    if (!TENANT_UUID_RE.test(tenantId)) {
      res.status(400).json({ error: 'invalid_tenant_id' });
      return;
    }
    const body = req.body as { monthly_chat_quota_override?: unknown };
    if (!Object.prototype.hasOwnProperty.call(body, 'monthly_chat_quota_override')) {
      res.status(400).json({ error: 'monthly_chat_quota_override_required' });
      return;
    }
    const raw = body.monthly_chat_quota_override;
    let value: number | null;
    if (raw === null) {
      value = null;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      value = clampChatQuotaOverride(raw);
    } else {
      res.status(400).json({ error: 'invalid_override' });
      return;
    }

    const updated = await withClient((c) => updateTenantChatQuotaOverride(c, tenantId, value));
    if (!updated) {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }
    res.json({ ok: true, tenant_id: tenantId, monthly_chat_quota_override: value });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

const PLAN_SLUG_RE = /^[a-z][a-z0-9_-]{1,48}$/;

export async function handleAdminBillingPlans(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const plans = await withClient((c) => listBillingPlansAdmin(c));
    res.json({
      plans,
      free_tier_monthly_chats: FREE_TIER_MONTHLY_CHATS,
      free_tier_max_indexed_products: FREE_TIER_MAX_INDEXED_PRODUCTS,
      stripe_note:
        'Stripe is not wired here yet; keep stripe_price_id for future Checkout/webhook mapping to plan slug.',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminBillingPlanUpsert(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const slug = String(req.params.slug ?? '').trim().toLowerCase();
    if (!PLAN_SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'invalid_plan_slug' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const mcl = Number(body.monthly_chat_limit);
    const mip = Number(body.max_indexed_products);
    const so = Number(body.sort_order);
    if (!Number.isFinite(mcl) || mcl < 0) {
      res.status(400).json({ error: 'invalid_monthly_chat_limit' });
      return;
    }
    if (!Number.isFinite(mip) || mip < 0) {
      res.status(400).json({ error: 'invalid_max_indexed_products' });
      return;
    }
    if (!Number.isFinite(so)) {
      res.status(400).json({ error: 'invalid_sort_order' });
      return;
    }
    const active = body.active !== false;
    const stripe_price_id =
      typeof body.stripe_price_id === 'string' && body.stripe_price_id.trim() !== ''
        ? body.stripe_price_id.trim()
        : null;

    await withClient((c) =>
      upsertBillingPlanAdmin(c, {
        slug,
        monthly_chat_limit: Math.floor(mcl),
        max_indexed_products: Math.floor(mip),
        sort_order: Math.floor(so),
        active,
        stripe_price_id,
      })
    );
    res.json({ ok: true, slug });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminTenantBillingPatch(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const tenantId = String(req.params.tenantId ?? '');
    if (!TENANT_UUID_RE.test(tenantId)) {
      res.status(400).json({ error: 'invalid_tenant_id' });
      return;
    }
    const body = req.body as { billing_plan_slug?: unknown; subscription_status?: unknown };
    const planRaw = body.billing_plan_slug;
    const subRaw = body.subscription_status;

    let billing_plan_slug: string | null;
    if (planRaw === null || planRaw === '') {
      billing_plan_slug = null;
    } else if (typeof planRaw === 'string' && planRaw.trim() !== '') {
      billing_plan_slug = planRaw.trim().toLowerCase();
    } else {
      res.status(400).json({ error: 'invalid_billing_plan_slug' });
      return;
    }

    let subscription_status: string | null = null;
    if (subRaw !== undefined && subRaw !== null && subRaw !== '') {
      if (typeof subRaw !== 'string') {
        res.status(400).json({ error: 'invalid_subscription_status' });
        return;
      }
      subscription_status = subRaw.trim().toLowerCase();
    }

    if (billing_plan_slug === null) {
      subscription_status = null;
    } else if (subscription_status === null || subscription_status === '') {
      subscription_status = 'active';
    }

    const ok = await withClient(async (c) => {
      if (billing_plan_slug !== null) {
        const p = await findBillingPlanBySlug(c, billing_plan_slug);
        if (!p || !p.active) {
          return { err: 'unknown_plan' as const };
        }
      }
      const updated = await updateTenantBillingManual(c, tenantId, billing_plan_slug, subscription_status);
      return updated ? { err: null } : { err: 'tenant_not_found' as const };
    });

    if (ok.err === 'unknown_plan') {
      res.status(400).json({ error: 'unknown_plan' });
      return;
    }
    if (ok.err === 'tenant_not_found') {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }

    res.json({ ok: true, tenant_id: tenantId, billing_plan_slug, subscription_status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}
