import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { withClient } from './db.js';
import {
  ADMIN_API_KEY,
  CHAT_CATALOG_CONTEXT_MAX_CHARS,
  CHAT_COMPLETION_MAX_TOKENS,
  CHAT_COMPLETION_MAX_TOKENS_CATALOG,
  CHAT_CONTEXT_MAX_CHARS_PER_ITEM,
  CHAT_PRODUCT_CARDS_MAX,
  CHAT_QUICK_REPLY_MAX_TOKENS,
  CHAT_RETRIEVAL_CHUNK_LIMIT,
  FREE_TIER_MAX_INDEXED_PRODUCTS,
  FREE_TIER_MONTHLY_CHATS,
  OPENAI_CHAT_MODEL,
} from './config.js';
import {
  clampChatQuotaOverride,
  countTenantsMatching,
  fetchTenantListRowById,
  fetchTenantsPage,
  getAdminConfigSnapshot,
  updateTenantChatQuotaOverride,
} from './adminRepo.js';
import {
  appendUserAssistantTurn,
  buildOpenAiHistoryFromStoredMessages,
  countChatSessionsForTenant,
  ensureChatSessionForTenant,
  fetchChatSessionByPublicId,
  isValidWpSessionPublicId,
  listChatSessionsForTenant,
  listMessagesForSession,
  newSessionPublicId,
  verifySessionBelongsToTenant,
} from './chatTranscriptRepo.js';
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
  adminListChunksForTenant,
  countDistinctIndexedProducts,
  deleteAllChunks,
  deleteChunksForExternals,
  deleteChunksForExternal,
  fetchChunksForExternals,
  insertChunk,
  listIndexedProducts,
  listIndexedPages,
  searchChunks,
  tenantHasIndexedProduct,
  type ChunkRow,
} from './chunksRepo.js';
import { embedManyWithOpenAi, embedTextWithOpenAi } from './embeddings.js';
import { generateAnswerWithOpenAi } from './llm.js';
import {
  dedupeProductCardsByUrl,
  enrichProductCardsWithImages,
  extractPriceTextFromMetadata,
  extractOfferTextFromMetadata,
  filterProductCardsForCompareQuery,
  mergeCardsWithProductRows,
  replaceImageLikeProductUrlsFromContext,
  resolvePlaceholderCardTitles,
  extractImageFromMetadata,
  productCardUrlKey,
} from './enrichProductCards.js';
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

/** One-line style hints keyed by WordPress tone preset slug. */
const TONE_PRESET_HINT: Record<string, string> = {
  custom: '',
  friendly: 'Warm retail; short paragraphs; clear and helpful.',
  professional: 'Formal B2B; precise; no slang; careful with policies and facts.',
  concise: 'Brief; bullets for lists; at most one clarifying question if unclear.',
  support: 'Patient support; acknowledge; step-by-step when useful.',
};

/** Skip embedding + vector search — saves multiple seconds on tiny talk. */
function isQuickSmallTalk(message: string): boolean {
  const t = message.trim();
  if (t.length > 96) return false;
  return /^(hi|hello|hey|hiya|howdy|good\s+(morning|afternoon|evening)|thanks|thank\s+you|thx|ok+|okay|bye|goodbye|how\s+are\s+you|how\'?re\s+you|what\'?s\s+up|sup|you\s+ok|everything\s+ok)[\s!.?]*$/i.test(
    t
  );
}

function buildCompactToneDirective(body: {
  tone_preset?: unknown;
  tone_notes?: unknown;
  tone?: unknown;
}): string {
  const presetRaw = String(body.tone_preset ?? '').trim().toLowerCase();
  const notes = String(body.tone_notes ?? '').trim().slice(0, 500);
  const legacy = String(body.tone ?? '').trim();

  if (presetRaw && Object.prototype.hasOwnProperty.call(TONE_PRESET_HINT, presetRaw)) {
    const hint = TONE_PRESET_HINT[presetRaw] ?? '';
    if (presetRaw === 'custom') {
      return notes ? `Notes: ${notes}` : '';
    }
    return [hint, notes ? `Notes: ${notes}` : ''].filter(Boolean).join(' ');
  }

  if (legacy) {
    return legacy.length > 1200 ? `${legacy.slice(0, 1200)}…` : legacy;
  }
  return notes ? `Notes: ${notes}` : '';
}

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

/** Numbered (1. …) or bullet (- / * …) lines — catalog outline uses bullets, so models often mirror that. */
function countProductListLines(answer: string): number {
  let n = 0;
  for (const line of answer.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\s*\d+\.\s+\S/.test(t) || /^\s*[-*]\s+\S/.test(t)) n += 1;
  }
  return n;
}

function titleKeyForMatch(s: string): string {
  return String(s ?? '')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * If we have `product_cards`, remove duplicated "product name" bullet/numbered lists from the text answer
 * so the UI doesn't show "list + cards".
 */
function stripProductListsWhenCardsPresent(
  answer: string,
  productCards: { title: string; url: string }[]
): { text: string; removedCount: number } {
  const raw = String(answer ?? '');
  if (!raw.trim()) return { text: raw, removedCount: 0 };
  if (!productCards || productCards.length === 0) return { text: raw, removedCount: 0 };

  const titleKeys = new Set(productCards.map((c) => titleKeyForMatch(c.title)).filter(Boolean));
  const urlKeys = new Set(
    productCards
      .map((c) => String(c.url ?? '').trim())
      .filter(Boolean)
      .map((u) => u.replace(/\/$/, '').toLowerCase())
  );

  const lines = raw.split(/\r?\n/);
  const keep: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const t = line.trim();
    const listMatch = /^(?:\d+\.)\s+(.+)$/.exec(t) || /^(?:[-*])\s+(.+)$/.exec(t);
    if (!listMatch) {
      keep.push(line);
      continue;
    }
    const itemRaw = listMatch[1] ?? '';
    const itemKey = titleKeyForMatch(itemRaw);
    const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(itemRaw);
    const href = link && link[2] ? String(link[2]).trim().replace(/\/$/, '').toLowerCase() : '';
    const isProductLine = (itemKey && titleKeys.has(itemKey)) || (href && urlKeys.has(href));
    if (isProductLine) {
      removed++;
      continue;
    }
    keep.push(line);
  }

  if (removed === 0) return { text: raw, removedCount: 0 };

  const cleaned = keep
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n+/g, '')
    .trimEnd();

  return { text: cleaned, removedCount: removed };
}

function titleHeadFromAnswerFragment(rest: string): string {
  let t = rest.trim().replace(/^[*_`]+|[*_`]+$/g, '');
  t = t.split(' — ')[0].split(' - ')[0].trim();
  return t;
}

function rowTitleMatchesLineFragment(rowTitle: string, lineFragment: string): boolean {
  const a = rowTitle.trim().toLowerCase().replace(/\s+/g, ' ');
  const b = lineFragment.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const aw = a.replace(/[^a-z0-9+]/gi, '');
  const bw = b.replace(/[^a-z0-9+]/gi, '');
  if (aw.length >= 2 && bw.length >= 2 && (aw.startsWith(bw) || bw.startsWith(aw))) return true;
  return false;
}

/**
 * Build cards from numbered or bullet product lines by matching titles to retrieved product rows.
 * Mirrors catalog outline bullets (- [title](url)) and numbered lists (1. …).
 */
function inferProductCardsFromListLines(
  answer: string,
  chunkRows: ChunkRow[],
): { title: string; url: string; price_text: string; image_url: string }[] {
  const productRows = chunkRows.filter((r) => String(r.source_type ?? '') === 'product');
  const cards: { title: string; url: string; price_text: string; image_url: string }[] = [];
  const seenUrl = new Set<string>();
  for (const line of answer.split(/\r?\n/)) {
    const trimmed = line.trim();
    let m = /^\s*\d+\.\s+(.+)$/.exec(trimmed);
    if (!m) {
      m = /^\s*[-*]\s+(.+)$/.exec(trimmed);
    }
    if (!m) continue;
    let rest = m[1].trim();
    if (/^(price|stock|description|ingredients)\b/i.test(rest)) continue;
    rest = rest.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1').trim();
    const lineTitle = titleHeadFromAnswerFragment(rest);
    if (!lineTitle) continue;
    for (const r of productRows) {
      const rt = String(r.title ?? '').trim();
      if (!rt) continue;
      if (!rowTitleMatchesLineFragment(rt, lineTitle)) continue;
      const url = String(r.url ?? '').trim();
      if (!url) continue;
      const uk = productCardUrlKey(url);
      if (seenUrl.has(uk)) continue;
      seenUrl.add(uk);
      let price_text = '';
      const priceM = /\bPrice:\s*(.+)$/i.exec(rest);
      if (priceM) price_text = priceM[1].trim().slice(0, 80);
      const image_url = extractImageFromMetadata(r.metadata);
      cards.push({ title: rt, url, price_text, image_url });
      break;
    }
  }
  return cards;
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

function coerceDeleteExternalIds(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim() : ''))
      .filter((s) => s.length > 0);
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return [raw.trim()];
  }
  return [];
}

export async function handleIngest(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      items?: unknown[];
      delete_external_ids?: unknown;
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
      const deleteExternalIds = coerceDeleteExternalIds(body.delete_external_ids);
      if (deleteExternalIds.length) {
        await deleteChunksForExternals(c, tenant.id, deleteExternalIds);
      }

      const items = Array.isArray(body.items) ? body.items : [];

      /** Delete-only (or full_reindex with no new items): no embeddings required. */
      if (items.length === 0) {
        await recordUsageAndTouch(c, tenant.id, {
          ingestRequest: 1,
          indexedItems: 0,
          embedTokens: 0,
        });
        const maxProductsQuick = await getMaxIndexedProductsForTenant(c, tenant);
        const indexed_product_count = await countDistinctIndexedProducts(c, tenant.id);
        return {
          err: null,
          n: 0,
          indexed_product_count,
          max_indexed_products: maxProductsQuick,
          skipped_products: 0,
        };
      }

      const apiKey = await resolveOpenAiApiKey(c);
      const maxProducts = await getMaxIndexedProductsForTenant(c, tenant);
      const unlimited = maxProducts <= 0;
      let runningDistinct = await countDistinctIndexedProducts(c, tenant.id);
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
        if (parts.length === 0) continue;

        // Batch embeddings for all chunks of this item in a single OpenAI request.
        const { embeddings, promptTokens } = await embedManyWithOpenAi(
          parts.map((p) => p.text),
          apiKey
        );
        embedTokens += promptTokens;

        for (let idx = 0; idx < parts.length; idx++) {
          const part = parts[idx];
          const vec = embeddings[idx];
          await insertChunk(c, {
            tenant_id: tenant.id,
            external_id,
            chunk_index: idx,
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
            emb_openai: vec,
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
      /** @deprecated Prefer tone_preset + tone_notes from WordPress. */
      tone?: string;
      tone_preset?: string;
      tone_notes?: string;
      session_id?: string;
      /** Prior turns from the storefront (WordPress forwards this). */
      history?: unknown;
      wp_user_id?: unknown;
      ip_hash?: unknown;
      strict_grounding?: boolean;
      published_products?: unknown;
      catalog_context?: unknown;
    };
    const message = String(body.message ?? '').trim();
    if (!message) {
      res.status(400).json({ error: 'message_required' });
      return;
    }
    const rawSession = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    const sessionPublicId = isValidWpSessionPublicId(rawSession) ? rawSession : newSessionPublicId();
    const wpUserRaw = body.wp_user_id;
    const shopperWpUserId =
      typeof wpUserRaw === 'number' && Number.isFinite(wpUserRaw) && wpUserRaw > 0
        ? Math.floor(wpUserRaw)
        : typeof wpUserRaw === 'string' && /^\d+$/.test(wpUserRaw)
          ? Math.max(0, parseInt(wpUserRaw, 10))
          : null;
    const effectiveShopperId = shopperWpUserId !== null && shopperWpUserId > 0 ? shopperWpUserId : null;
    const ipHashRaw = body.ip_hash;
    const ipHash =
      typeof ipHashRaw === 'string' && ipHashRaw.trim() !== '' ? ipHashRaw.trim().slice(0, 128) : null;

    const publishedProducts = parsePublishedProductsFromChatBody(body as Record<string, unknown>);
    const catalogRaw = body.catalog_context;
    const catalogContext =
      typeof catalogRaw === 'string' && catalogRaw.trim() !== ''
        ? catalogRaw.trim().slice(0, CHAT_CATALOG_CONTEXT_MAX_CHARS)
        : '';
    const hasCatalogOutline = catalogContext.length > 0;
    /** Greetings must not run retrieval: "hi" + embedding still matches arbitrary products when catalog outline is present. */
    const quickReply = isQuickSmallTalk(message);

    const reqId = Math.random().toString(16).slice(2, 10);
    const t0 = Date.now();

    const result = await withClient(async (c) => {
      const marks: Record<string, number> = {};
      const mark = (k: string) => {
        marks[k] = Date.now();
      };
      mark('start');

      const tenant = await authTenant(c, req);
      if (!tenant) {
        return { kind: 'unauth' as const };
      }
      mark('auth');

      const gate = await checkChatQuota(c, tenant);
      if (!gate.ok) {
        return { kind: 'quota' as const, gate };
      }
      mark('quota');

      const sessionRow = await ensureChatSessionForTenant(c, tenant.id, sessionPublicId, {
        shopperWpUserId: effectiveShopperId,
        ipHash,
      });
      mark('session');
      const history = sanitizeChatHistory(body.history, 16);
      mark('history_ready');

      const apiKey = await resolveOpenAiApiKey(c);
      mark('resolve_key');

      let rows: ChunkRow[] = [];
      let embedTokens = 0;
      let indexedDistinct = 0;
      let maxIndexed = 0;

      if (quickReply) {
        mark('embed+counts');
        mark('vector_search');
        mark('fetch_chunks');
        mark('merge_chunks');
      } else {
        const [qEmb, idc, mi] = await Promise.all([
          embedTextWithOpenAi(message, apiKey),
          countDistinctIndexedProducts(c, tenant.id),
          getMaxIndexedProductsForTenant(c, tenant),
        ]);
        indexedDistinct = idc;
        maxIndexed = mi;
        embedTokens = qEmb.promptTokens;
        mark('embed+counts');

        const hits = await searchChunks(c, {
          tenantId: tenant.id,
          openai: qEmb.embedding,
          limit: CHAT_RETRIEVAL_CHUNK_LIMIT,
        });
        mark('vector_search');
        const hitIds = [...new Set(hits.map((h) => h.external_id))];
        const allChunks = await fetchChunksForExternals(c, tenant.id, hitIds);
        mark('fetch_chunks');
        rows = mergeRetrievedChunks(hits, allChunks);
        mark('merge_chunks');
      }

      const contextBlocks = rows.map((r, i) => {
        const img = extractImageFromMetadata(r.metadata);
        const imgPart = img ? ` image=${img}` : '';
        let truncated = r.content;
        if (truncated.length > CHAT_CONTEXT_MAX_CHARS_PER_ITEM) {
          truncated = `${truncated.slice(0, CHAT_CONTEXT_MAX_CHARS_PER_ITEM)}\n…`;
        }
        return `[#${i + 1}] title=${r.title} url=${r.url} type=${r.source_type}${imgPart}\n${truncated}`;
      });
      const contextSectionJoined =
        contextBlocks.length > 0
          ? contextBlocks.join('\n\n---\n\n')
          : '(no retrieval matches for this query)';

      const toneDirective = buildCompactToneDirective(body);
      const strict = body.strict_grounding !== false;

      let system: string;
      let userContent: string;
      let maxChatTokens: number;

      if (quickReply) {
        maxChatTokens = CHAT_QUICK_REPLY_MAX_TOKENS;
        system = [
          'You are a helpful storefront assistant.',
          toneDirective ? `Voice: ${toneDirective}` : '',
          'The shopper sent a very short greeting or thanks. Reply warmly in 1–3 sentences. No products, no shopping, no catalog.',
          'Respond with exactly one JSON object (no markdown code fences). product_cards MUST be []. suggestions MUST be [].',
          '{"answer":string,"closing_text":string,"citations":[],"suggestions":[],"product_cards":[]}',
        ]
          .filter(Boolean)
          .join('\n');
        userContent = message;
      } else {
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

        maxChatTokens = hasCatalogOutline
          ? CHAT_COMPLETION_MAX_TOKENS_CATALOG
          : CHAT_COMPLETION_MAX_TOKENS;

        const catalogBlock = hasCatalogOutline
          ? [
              '=== STORE CATALOG OUTLINE (from WooCommerce / WordPress) ===',
              'This block includes STORE NAME, SITE TAGLINE, product CATEGORIES, BRANDS, TAGS, and promotion/on-sale hints only. It does NOT list individual products.',
              'Use it for: store positioning, taxonomy (categories/brands/tags), and high-level “what kind of shop is this”. For any specific product names, URLs, prices, images, or recommendations, you MUST use RETRIEVAL CONTEXT below (AI-indexed products). Never invent or enumerate a full product catalog from this outline alone.',
              'Include category, brand, and tag names from the outline when the shopper asks what you carry at a high level. If they want concrete products to buy, rely on RETRIEVAL CONTEXT and product_cards rules.',
              'published_products in the system message is the live WooCommerce count; the AI search index may index fewer — recommendations are limited to indexed items.',
              'For one product’s price, specs, or description, use RETRIEVAL CONTEXT when it mentions that product.',
              '',
              catalogContext,
              '=== END STORE CATALOG OUTLINE ===',
            ].join('\n')
          : '';

        const systemParts = [
          'You are a helpful storefront assistant. Be concise: lead with the answer, then short supporting detail only when helpful.',
          catalogBlock,
          'Earlier messages in this chat (if any) are provided for continuity — use them to stay coherent and to tailor follow-ups.',
          toneDirective ? `Voice: ${toneDirective}` : '',
          storeCountLines.join(' '),
          'If the user only greets you or chats casually (e.g. hello, how are you) and CONTEXT is empty or not relevant, reply in one or two friendly sentences. Use citations: [].',
          strict
            ? 'For product facts (descriptions, price, SKU, stock, etc.), use CONTEXT when it mentions those products. For store-wide totals or "how many products", use the live catalog and index figures from this system message (never CONTEXT size or [#n] count). When both live catalog and index counts were given and they differ, inventory-style questions must use the live catalog number first. For each product the user asks about that appears in CONTEXT, include relevant details from CONTEXT; avoid repeating the entire catalog unless asked.'
            : 'Prefer the CONTEXT when relevant for product details; for store-wide product totals, follow the live catalog vs index rules above.',
          'Say you do not have a piece of information only when that specific fact does not appear anywhere in CONTEXT or the STORE CATALOG OUTLINE (when present). Do not refuse to give "more detail" when CONTEXT already includes descriptions or specs—extract and present them.',
          hasCatalogOutline
            ? 'Store-wide questions about categories, brands, tags, or niche: use the STORE CATALOG OUTLINE. Lists of specific products to shop must come from RETRIEVAL CONTEXT only (indexed products), not from inventing inventory from the outline.'
            : 'When listing multiple products, use a short friendly sentence, then a numbered list of product names (plain text) using only items supported by RETRIEVAL CONTEXT. Use [title](url) when the URL is in CONTEXT.',
          'Product cards: use exact product titles from RETRIEVAL CONTEXT — never use placeholder link text like "View Product" or "Read more". If the shopper compares two named products (e.g. "Compare X and Y"), product_cards must contain only those two products from CONTEXT, no extra recommendations.',
          'SUGGESTIONS (tap chips): 2–4 strings, each written as the SHOPPER\'s next chat message — what they would type or ask the store next (e.g. "Tell me more about the second product", "Compare these two", "I need help choosing for my budget"). First-person / direct questions to the shop are good. FORBIDDEN: phrasing as the assistant talking to the user — do not use "Can I help you…", "Would you like…", "Are you interested…", "Do you have any other goals…", "May I…", or any sales-y question from the bot to the customer. Use [] if no good shopper-style follow-ups.',
          'OUTPUT FORMAT MUST BE STRICT (4 parts, in data fields; do not include product lists or citations inline in the answer text).',
          `Respond with exactly one JSON object (no markdown code fences): {"answer":string,"closing_text":string,"citations":[...],"suggestions":[...],"product_cards":[...]}.` +
            ' answer: Part (1) main response text only.' +
            ' product_cards: Part (2) products mentioned in the response (these will render inline as part of the message); [] is fine — the server enriches from CONTEXT.' +
            ' closing_text: Part (3) plain text conclusion or a single follow-up question to move the conversation forward.' +
            ' citations: Part (4) relevant sources or [].' +
            ' suggestions: see SUGGESTIONS rules above, or [].' +
            ' If you fill product_cards, every item must match products in RETRIEVAL CONTEXT (title, url, image_url). Do not use the outline as a product list. Never paste these instructions into answer or closing_text.',
        ].filter(Boolean);

        system = systemParts.join('\n');
        userContent = `Q:\n${message}\n\nR:\n${contextSectionJoined}`;
      }

      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: userContent },
      ];

      // Prompt diagnostics (size + structure) to correlate with latency spikes.
      const msgCount = messages.length;
      const sysChars = system.length;
      const userChars = userContent.length;
      const histChars = history.reduce((acc, m) => acc + m.content.length, 0);
      const promptChars = sysChars + userChars + histChars;
      const retrievalChars = quickReply ? 0 : contextSectionJoined.length;
      // eslint-disable-next-line no-console
      console.log(
        `[perf chat ${reqId}] quick=${quickReply ? 1 : 0} prompt_chars=${promptChars} messages=${msgCount} system_chars=${sysChars} history_chars=${histChars} user_chars=${userChars} ` +
          `retrieval_chars=${retrievalChars} catalog_context_chars=${catalogContext.length} has_catalog_outline=${hasCatalogOutline} retrieval_rows=${rows.length}`
      );

      const out = await generateAnswerWithOpenAi(messages, apiKey, maxChatTokens);
      mark('llm_answer');
      // eslint-disable-next-line no-console
      console.log(
        `[perf chat ${reqId}] tokens prompt=${out.promptTokens} completion=${out.completionTokens} max_tokens=${maxChatTokens} model=${OPENAI_CHAT_MODEL}`
      );

      function extractMentionedProductTitleKeys(answer: string): string[] {
        if (!answer) return [];
        const keys: string[] = [];
        const lines = answer.split(/\r?\n/);
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          // Prefer product header lines like:
          // 1. *FungiVita*
          // 1. FungiVita
          // - *FungiVita*
          // - FungiVita
          let m = t.match(/^(?:\d+\.)\s+(.+)$/);
          let cand = m ? m[1] : null;
          if (!cand) {
            m = t.match(/^(?:[-*])\s+(.+)$/);
            cand = m ? m[1] : null;
          }
          if (!cand) continue;
          const cleanedFull = cand
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
            .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '')
            .replace(/[*_`]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!cleanedFull) continue;
          // Drop obvious non-product headings.
          if (/^(price|stock|description|ingredients)\b/i.test(cleanedFull)) continue;

          // If the model prints "TITLE - details", keep just the title part too.
          const titleOnly = cleanedFull.split(' - ')[0]?.split(' — ')[0]?.trim() ?? cleanedFull;
          const titleKey = titleOnly.replace(/\s+/g, ' ').trim().toLowerCase();
          if (titleKey) {
            keys.push(titleKey);
          }
          if (keys.length >= CHAT_PRODUCT_CARDS_MAX * 2) break;
        }
        return keys;
      }

      /**
       * Some completions mention products inline (no numbered/bullet list), e.g.
       * "Here are more items we carry: Foo, Bar, Baz, and Qux."
       * Extract those candidate titles so we can attach product_cards from retrieval.
       */
      function extractInlineMentionedTitles(answer: string): string[] {
        const t = String(answer ?? '').trim();
        if (!t) return [];
        // Grab the text after a colon if present; otherwise use the whole sentence.
        const afterColon = t.includes(':') ? t.split(':').slice(1).join(':') : t;
        // Stop at the first sentence end to avoid trailing prose.
        const head = afterColon.split(/[.!?\n]/)[0] ?? afterColon;
        const cleaned = head
          .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
          .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '')
          .replace(/[*_`]+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!cleaned) return [];

        // Split on commas and the final "and".
        const parts = cleaned
          .replace(/\s+and\s+/gi, ', ')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);

        const out: string[] = [];
        for (const p of parts) {
          if (!p) continue;
          if (/^(price|stock|description|ingredients)\b/i.test(p)) continue;
          const titleOnly = p.split(' - ')[0]?.split(' — ')[0]?.trim() ?? p;
          if (titleOnly) out.push(titleOnly);
          if (out.length >= CHAT_PRODUCT_CARDS_MAX * 2) break;
        }
        return out;
      }

      function inferProductCardsFromAnswerMarkdown(answer: string) {
        const cards: { title: string; url: string; price_text: string; image_url: string }[] = [];
        if (!answer) return cards;

        // Collect markdown images by alt/title so we can attach thumbnails.
        const imgByAlt = new Map<string, string>();
        const imgRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
        let mi: RegExpExecArray | null;
        while ((mi = imgRe.exec(answer)) !== null) {
          const alt = String(mi[1] ?? '').trim().toLowerCase();
          const src = String(mi[2] ?? '').trim();
          if (!alt || !src) continue;
          imgByAlt.set(alt, src);
        }

        // Do not match the inner [alt](url) of markdown images ![alt](url) — that would use image URLs as product links.
        const linkRe = /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(answer)) !== null) {
          const title = String(m[1] ?? '').trim();
          const url = String(m[2] ?? '').trim();
          if (!title || !url) continue;
          if (/^(view product|read more|learn more|shop now|buy now|click here|see product)$/i.test(title)) {
            continue;
          }
          // Skip non-http and non-site-relative links; keep localhost for dev.
          if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) continue;
          cards.push({
            title,
            url,
            price_text: '',
            image_url: imgByAlt.get(title.toLowerCase()) ?? '',
          });
          if (cards.length >= CHAT_PRODUCT_CARDS_MAX) break;
        }
        return cards;
      }

      function inferProductCardsFromContextRows() {
        const cards: {
          title: string;
          url: string;
          price_text: string;
          offer_text?: string;
          image_url: string;
        }[] = [];
        for (const r of rows) {
          if (!r) continue;
          // Prefer actual product chunks.
          if (String(r.source_type ?? '') !== 'product') continue;
          const title = String(r.title ?? '').trim();
          const url = String(r.url ?? '').trim();
          if (!title || !url) continue;
          const image_url = extractImageFromMetadata(r.metadata);
          const price_text = extractPriceTextFromMetadata(r.metadata);
          const offer_text = extractOfferTextFromMetadata(r.metadata);
          cards.push({ title, url, price_text, offer_text: offer_text || undefined, image_url });
          if (cards.length >= CHAT_PRODUCT_CARDS_MAX) break;
        }
        return cards;
      }

      const policyQ = /\b(shipping|delivery|returns?|refunds?|exchange|warranty|contact|support|opening\s+hours|hours|location|store\s+hours|payment|billing)\b/i.test(
        message
      );
      /** Model + markdown links + plain "1. Name - … Price:" lines matched to retrieval; CONTEXT backfill when list is longer. */
      const fromModel = !policyQ && out.product_cards && out.product_cards.length ? out.product_cards : [];
      const fromAnswer = policyQ ? [] : inferProductCardsFromAnswerMarkdown(out.answer);
      const fromListLines = policyQ ? [] : inferProductCardsFromListLines(out.answer, rows);
      const fromInlineMentions = policyQ
        ? []
        : inferProductCardsFromListLines(
            extractInlineMentionedTitles(out.answer)
              .map((x, i) => `${i + 1}. ${x}`)
              .join('\n'),
            rows
          );
      let mergedModelAnswer = dedupeProductCardsByUrl([
        ...fromModel,
        ...fromAnswer,
        ...fromListLines,
        ...fromInlineMentions,
      ]);
      const productListLineCount = countProductListLines(out.answer);
      const productRowCount = rows.filter((r) => String(r.source_type ?? '') === 'product').length;
      /** Never attach random retrieval products when the model returned none and we inferred none from the answer. */
      let fromContext: { title: string; url: string; price_text: string; image_url: string }[] = [];
      if (
        !policyQ &&
        fromModel.length === 0 &&
        mergedModelAnswer.length > 0 &&
        (productListLineCount > mergedModelAnswer.length || productRowCount > mergedModelAnswer.length)
      ) {
        /** Answer already lists or implies specific products — merge extra retrieval hits if needed. */
        fromContext = inferProductCardsFromContextRows();
      }
      const mergedCards = dedupeProductCardsByUrl([...mergedModelAnswer, ...fromContext]).slice(
        0,
        CHAT_PRODUCT_CARDS_MAX
      );
      const product_cards = replaceImageLikeProductUrlsFromContext(
        filterProductCardsForCompareQuery(
          message,
          resolvePlaceholderCardTitles(
            mergeCardsWithProductRows(
              enrichProductCardsWithImages(mergedCards, rows),
              rows,
              CHAT_PRODUCT_CARDS_MAX
            ),
            rows
          ),
          rows
        ),
        rows
      );
      mark('postprocess_cards');

      /** Full answer text; product cards are shown separately — do not strip headings/bullets that mention product names. */
      const listStrip = policyQ ? { text: out.answer, removedCount: 0 } : stripProductListsWhenCardsPresent(out.answer, product_cards);
      const cleanedAnswer = listStrip.text;
      mark('answer_ready');
      const transcriptAssistant =
        cleanedAnswer + (out.closing_text && String(out.closing_text).trim() ? `\n\n${String(out.closing_text).trim()}` : '');
      await appendUserAssistantTurn(c, sessionRow.id, message, transcriptAssistant);
      mark('store_transcript');
      await recordUsageAndTouch(c, tenant.id, {
        chat: 1,
        embedTokens,
        chatPromptTokens: out.promptTokens,
        chatCompletionTokens: out.completionTokens,
      });
      mark('usage');

      // Log timings for diagnosis.
      const fmt = (a: string, b: string) =>
        marks[a] && marks[b] ? `${b}:${marks[b] - marks[a]}ms` : `${b}:?`;
      // eslint-disable-next-line no-console
      console.log(
        `[perf chat ${reqId}] total=${Date.now() - t0}ms ` +
          [
            fmt('start', 'auth'),
            fmt('auth', 'quota'),
            fmt('quota', 'session'),
            fmt('session', 'history_ready'),
            fmt('history_ready', 'resolve_key'),
            fmt('resolve_key', 'embed+counts'),
            fmt('embed+counts', 'vector_search'),
            fmt('vector_search', 'fetch_chunks'),
            fmt('fetch_chunks', 'merge_chunks'),
            fmt('merge_chunks', 'llm_answer'),
            fmt('llm_answer', 'postprocess_cards'),
            fmt('postprocess_cards', 'answer_ready'),
            fmt('answer_ready', 'store_transcript'),
            fmt('store_transcript', 'usage'),
          ].join(' ')
      );
      const replyProductCards = quickReply ? [] : product_cards;
      const replySuggestions = quickReply ? [] : out.suggestions;
      return {
        kind: 'ok' as const,
        out: { ...out, answer: cleanedAnswer, product_cards: replyProductCards, suggestions: replySuggestions },
        session_id: sessionRow.public_id,
      };
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
      closing_text: String(result.out.closing_text ?? ''),
      citations: result.out.citations,
      suggestions: result.out.suggestions,
      product_cards: result.out.product_cards,
      session_id: result.session_id,
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

/**
 * Storefront history: tenant Bearer + optional viewer_wp_user_id for sessions bound to a WP user.
 */
export async function handleStorefrontChatSessionMessages(req: Request, res: Response): Promise<void> {
  try {
    const publicId = String(req.params.publicId ?? '').trim();
    if (!isValidWpSessionPublicId(publicId)) {
      res.status(400).json({ error: 'invalid_session_id' });
      return;
    }
    const viewerRaw = req.query.viewer_wp_user_id;
    const viewerWpUserId =
      typeof viewerRaw === 'string' && /^\d+$/.test(viewerRaw)
        ? parseInt(viewerRaw, 10)
        : typeof viewerRaw === 'number' && Number.isFinite(viewerRaw)
          ? Math.floor(viewerRaw)
          : 0;

    const payload = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return { kind: 'unauth' as const };
      }
      const session = await fetchChatSessionByPublicId(c, tenant.id, publicId);
      if (!session) {
        return { kind: 'missing' as const };
      }
      if (
        session.shopper_wp_user_id !== null &&
        session.shopper_wp_user_id !== viewerWpUserId
      ) {
        return { kind: 'forbidden' as const };
      }
      const rows = await listMessagesForSession(c, session.id, 500);
      const messages = rows.map((m) => ({ role: m.role, content: m.content }));
      return { kind: 'ok' as const, session_id: publicId, messages };
    });

    if (payload.kind === 'unauth') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (payload.kind === 'missing') {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    if (payload.kind === 'forbidden') {
      res.status(403).json({ error: 'session_forbidden' });
      return;
    }
    res.json({ session_id: payload.session_id, messages: payload.messages });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

/** wp-admin Chat sessions tab: list sessions for this tenant (Bearer). */
export async function handleTenantChatSessionsList(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const payload = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return { kind: 'unauth' as const };
      }
      const total = await countChatSessionsForTenant(c, tenant.id);
      const sessions = await listChatSessionsForTenant(c, tenant.id, limit, offset);
      return { kind: 'ok' as const, total, sessions };
    });

    if (payload.kind === 'unauth') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({
      total: payload.total,
      limit,
      offset,
      sessions: payload.sessions,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

/** wp-admin session detail: full transcript with timestamps (Bearer). */
export async function handleTenantChatSessionMessages(req: Request, res: Response): Promise<void> {
  try {
    const publicId = String(req.params.publicId ?? '').trim();
    if (!isValidWpSessionPublicId(publicId)) {
      res.status(400).json({ error: 'invalid_session_id' });
      return;
    }

    const payload = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return { kind: 'unauth' as const };
      }
      const session = await fetchChatSessionByPublicId(c, tenant.id, publicId);
      if (!session) {
        return { kind: 'missing' as const };
      }
      const messages = await listMessagesForSession(c, session.id, 2000);
      return { kind: 'ok' as const, session, messages };
    });

    if (payload.kind === 'unauth') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (payload.kind === 'missing') {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    res.json({
      session_id: payload.session.public_id,
      shopper_wp_user_id: payload.session.shopper_wp_user_id,
      created_at: payload.session.created_at,
      updated_at: payload.session.updated_at,
      messages: payload.messages,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
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

/** wp-admin: products currently stored in the AI search index (Bearer). */
export async function handleTenantIndexedProducts(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const payload = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return { kind: 'unauth' as const };
      }
      const { total, rows } = await listIndexedProducts(c, tenant.id, limit, offset);
      return { kind: 'ok' as const, total, rows };
    });

    if (payload.kind === 'unauth') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({
      total: payload.total,
      limit,
      offset,
      products: payload.rows,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

/** wp-admin: WordPress pages in the AI index (Bearer). */
export async function handleTenantIndexedPages(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const payload = await withClient(async (c) => {
      const tenant = await authTenant(c, req);
      if (!tenant) {
        return { kind: 'unauth' as const };
      }
      const { total, rows } = await listIndexedPages(c, tenant.id, limit, offset);
      return { kind: 'ok' as const, total, rows };
    });

    if (payload.kind === 'unauth') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({
      total: payload.total,
      limit,
      offset,
      pages: payload.rows,
    });
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

export async function handleAdminTenantDetail(req: Request, res: Response): Promise<void> {
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

    const data = await withClient(async (c) => {
      const tenant = await fetchTenantListRowById(c, tenantId);
      if (!tenant) {
        return null;
      }
      const chat_sessions_total = await countChatSessionsForTenant(c, tenantId);
      return { tenant, chat_sessions_total };
    });

    if (!data) {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }

    const cost = estimateOpenAiCostUsd({
      embed_tokens: data.tenant.embed_tokens_30d,
      chat_prompt_tokens: data.tenant.chat_prompt_tokens_30d,
      chat_completion_tokens: data.tenant.chat_completion_tokens_30d,
    });
    res.json({
      tenant: {
        ...data.tenant,
        estimated_openai_usd_30d: cost.estimated_openai_usd_total,
        estimated_embed_usd_30d: cost.estimated_embed_usd,
        estimated_chat_usd_30d: cost.estimated_chat_input_usd + cost.estimated_chat_output_usd,
      },
      chat_sessions_total: data.chat_sessions_total,
      cost_estimate: openAiCostEstimateMeta(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

/** Operator: browse stored chunks (indexed text) for a tenant. */
export async function handleAdminTenantChunks(req: Request, res: Response): Promise<void> {
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
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const sourceType = String(req.query.source_type ?? '').trim();
    const q = String(req.query.q ?? '').trim();

    const payload = await withClient(async (c) => {
      const tenant = await fetchTenantListRowById(c, tenantId);
      if (!tenant) {
        return { kind: 'missing' as const };
      }
      const { total, rows } = await adminListChunksForTenant(c, tenantId, {
        limit,
        offset,
        sourceType,
        q,
      });
      return { kind: 'ok' as const, total, rows };
    });

    if (payload.kind === 'missing') {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }
    res.json({
      total: payload.total,
      limit,
      offset,
      chunks: payload.rows,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminTenantChats(req: Request, res: Response): Promise<void> {
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
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const payload = await withClient(async (c) => {
      const tenant = await fetchTenantListRowById(c, tenantId);
      if (!tenant) {
        return { kind: 'missing' as const };
      }
      const total = await countChatSessionsForTenant(c, tenantId);
      const sessions = await listChatSessionsForTenant(c, tenantId, limit, offset);
      return { kind: 'ok' as const, total, sessions };
    });

    if (payload.kind === 'missing') {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }
    res.json({
      total: payload.total,
      limit,
      offset,
      sessions: payload.sessions,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleAdminTenantChatMessages(req: Request, res: Response): Promise<void> {
  try {
    if (!adminBearerAuthorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const tenantId = String(req.params.tenantId ?? '');
    const sessionId = String(req.params.sessionId ?? '');
    if (!TENANT_UUID_RE.test(tenantId) || !TENANT_UUID_RE.test(sessionId)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }

    const messages = await withClient(async (c) => {
      const ok = await verifySessionBelongsToTenant(c, tenantId, sessionId);
      if (!ok) {
        return null;
      }
      return listMessagesForSession(c, sessionId, 2000);
    });

    if (!messages) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    res.json({ session_id: sessionId, messages });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

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
