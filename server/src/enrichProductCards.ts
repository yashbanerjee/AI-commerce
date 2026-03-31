import type { ProductCard } from './llm.js';
import type { ChunkRow } from './chunksRepo.js';

function normalizeImageUrlString(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('//')) s = `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s.slice(0, 2000);
  return '';
}

export function extractImageFromMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const m = metadata as Record<string, unknown>;
  const candidates = [m.image, m.image_url, m.thumbnail, m.thumb];
  for (const v of candidates) {
    if (typeof v === 'string') {
      const n = normalizeImageUrlString(v);
      if (n) return n;
    }
  }
  return '';
}

/** WooCommerce sync stores plain-text price in metadata. */
export function extractPriceTextFromMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const m = metadata as Record<string, unknown>;
  const raw = m.price_text;
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

export function productCardUrlKey(u: string): string {
  const t = u.trim();
  if (!t) return '';
  try {
    const parsed = /^https?:\/\//i.test(t) ? new URL(t) : new URL(t, 'https://placeholder.local');
    // Same host + `/` pathname is shared by all `/?product=slug` PDPs — include search for dedupe/merge keys.
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return t.replace(/\/$/, '').toLowerCase();
  }
}

function titleMatchKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when the URL points at a static image (not a product page). */
export function looksLikeImageAssetUrl(url: string): boolean {
  const t = url.trim();
  if (!t) return false;
  try {
    const parsed = /^https?:\/\//i.test(t) ? new URL(t) : new URL(t, 'https://placeholder.local');
    const path = parsed.pathname + parsed.search;
    return /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i.test(path);
  } catch {
    return /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i.test(t);
  }
}

/**
 * When the model or markdown inference puts an image URL in `url`, replace it with the product page URL
 * from indexed chunks when titles match.
 */
export function replaceImageLikeProductUrlsFromContext(cards: ProductCard[], contextRows: ChunkRow[]): ProductCard[] {
  const productRows = contextRows.filter((r) => String(r.source_type ?? '') === 'product');
  const urlByTitle = new Map<string, string>();
  for (const r of productRows) {
    const tk = titleMatchKey(r.title);
    const u = String(r.url ?? '').trim();
    if (!tk || !u || looksLikeImageAssetUrl(u)) continue;
    if (!urlByTitle.has(tk)) urlByTitle.set(tk, u);
  }
  return cards
    .map((card) => {
      const raw = String(card.url ?? '').trim();
      if (!raw || !looksLikeImageAssetUrl(raw)) return card;
      const tk = titleMatchKey(card.title);
      const fixed = tk ? urlByTitle.get(tk) : undefined;
      if (fixed) return { ...card, url: fixed };
      return { ...card, url: '' };
    })
    .filter((card) => {
      const u = String(card.url ?? '').trim();
      return u !== '' && !looksLikeImageAssetUrl(u);
    });
}

/**
 * Fills image_url on product cards from retrieved chunk metadata when the model omits it.
 */
export function enrichProductCardsWithImages(cards: ProductCard[], contextRows: ChunkRow[]): ProductCard[] {
  const imageByUrl = new Map<string, string>();
  const imageByTitle = new Map<string, string>();
  for (const r of contextRows) {
    const img = extractImageFromMetadata(r.metadata);
    if (!img) continue;
    const uk = productCardUrlKey(r.url);
    if (uk) imageByUrl.set(uk, img);
    const tk = titleMatchKey(r.title);
    if (tk) imageByTitle.set(tk, img);
  }

  return cards.map((card) => {
    let imageUrl = normalizeImageUrlString(card.image_url ?? '');
    if (imageUrl) {
      return { ...card, image_url: imageUrl };
    }
    const uk = productCardUrlKey(card.url);
    if (uk && imageByUrl.has(uk)) {
      return { ...card, image_url: imageByUrl.get(uk)! };
    }
    const tk = titleMatchKey(card.title);
    if (tk && imageByTitle.has(tk)) {
      return { ...card, image_url: imageByTitle.get(tk)! };
    }
    return { ...card, image_url: '' };
  });
}

/**
 * Fill missing thumbnails/prices from indexed product chunks and append top retrieval hits
 * so the storefront shows image cards even when the model omits image_url.
 */
export function mergeCardsWithProductRows(
  cards: ProductCard[],
  contextRows: ChunkRow[],
  max: number
): ProductCard[] {
  const productRows = contextRows.filter((r) => String(r.source_type ?? '') === 'product');
  const urlSeen = new Set<string>();

  const enriched = cards.map((card) => {
    let { title, url, price_text, image_url } = card;
    const uk = productCardUrlKey(url);
    if (uk) urlSeen.add(uk);
    if (normalizeImageUrlString(image_url)) return { ...card, image_url: normalizeImageUrlString(image_url) };
    const byUrl = productRows.find((r) => productCardUrlKey(String(r.url ?? '')) === uk);
    const byTitle =
      byUrl ??
      productRows.find((r) => titleMatchKey(String(r.title ?? '')) === titleMatchKey(title));
    if (!byTitle) return card;
    const img = extractImageFromMetadata(byTitle.metadata);
    const pt = price_text || extractPriceTextFromMetadata(byTitle.metadata);
    return {
      ...card,
      image_url: img || image_url || '',
      price_text: pt || price_text || '',
    };
  });

  let out = dedupeProductCardsByUrl(enriched);

  /** When the model (or upstream inference) already listed specific products, do not append extra retrieval hits. */
  if (cards.length === 0) {
    for (const r of productRows) {
      if (out.length >= max) break;
      const url = String(r.url ?? '').trim();
      const title = String(r.title ?? '').trim();
      if (!url || !title) continue;
      const uk = productCardUrlKey(url);
      if (uk && urlSeen.has(uk)) continue;
      const image_url = extractImageFromMetadata(r.metadata);
      if (!image_url) continue;
      if (uk) urlSeen.add(uk);
      out.push({
        title,
        url,
        price_text: extractPriceTextFromMetadata(r.metadata),
        image_url,
      });
    }
  }

  out = dedupeProductCardsByUrl(out);
  return out
    .sort((a, b) => {
      const ai = normalizeImageUrlString(a.image_url) ? 1 : 0;
      const bi = normalizeImageUrlString(b.image_url) ? 1 : 0;
      return bi - ai;
    })
    .slice(0, max);
}

/** WooCommerce / theme markdown often uses [View Product](url) — replace with real title from the index. */
const PLACEHOLDER_LINK_LABELS =
  /^(view product|read more|learn more|shop now|buy now|click here|see product|product link|more details)$/i;

function normalizeNameForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameMatchesTitle(name: string, title: string): boolean {
  const n = normalizeNameForMatch(name);
  const t = normalizeNameForMatch(title);
  if (!n || !t) return false;
  if (t.includes(n) || n.includes(t)) return true;
  const nWords = n.split(/\s+/).filter((w) => w.length > 1);
  const tWords = t.split(/\s+/).filter((w) => w.length > 1);
  if (nWords.length <= 1) {
    return tWords.some((tw) => tw.includes(n) || n.includes(tw));
  }
  return nWords.every((nw) => t.includes(nw));
}

/**
 * When the shopper asks to compare two named products, restrict cards to those items only
 * (avoids flooding the UI with other retrieval hits).
 */
export function extractCompareProductPair(message: string): [string, string] | null {
  const t = message.trim();
  const patterns: RegExp[] = [
    /\bcompare\s+(.+?)\s+and\s+(.+?)\s*\.?\s*$/i,
    /\bcompare\s+(.+?)\s+vs\.?\s+(.+?)\s*\.?\s*$/i,
    /\bdifference\s+between\s+(.+?)\s+and\s+(.+?)\s*\.?\s*$/i,
    /\b(.+?)\s+versus\s+(.+?)\s*\.?\s*$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) {
      const a = m[1].trim().replace(/[.?!]+$/g, '').trim();
      const b = m[2].trim().replace(/[.?!]+$/g, '').trim();
      if (a.length >= 2 && b.length >= 2 && a.toLowerCase() !== b.toLowerCase()) {
        return [a, b];
      }
    }
  }
  return null;
}

/** Replace generic link labels with indexed product titles matched by URL. */
export function resolvePlaceholderCardTitles(cards: ProductCard[], contextRows: ChunkRow[]): ProductCard[] {
  const productRows = contextRows.filter((r) => String(r.source_type ?? '') === 'product');
  return cards.map((card) => {
    const title = String(card.title ?? '').trim();
    if (!PLACEHOLDER_LINK_LABELS.test(title) && title.length >= 3) return card;
    const uk = productCardUrlKey(String(card.url ?? ''));
    if (!uk) return card;
    const row = productRows.find((r) => productCardUrlKey(String(r.url ?? '')) === uk);
    const realTitle = row ? String(row.title ?? '').trim() : '';
    if (realTitle) {
      return { ...card, title: realTitle };
    }
    return card;
  });
}

/**
 * If the message is a two-product compare query, keep only cards for those products.
 */
export function filterProductCardsForCompareQuery(
  message: string,
  cards: ProductCard[],
  contextRows: ChunkRow[]
): ProductCard[] {
  const pair = extractCompareProductPair(message);
  if (!pair) return cards;
  const [n1, n2] = pair;
  const productRows = contextRows.filter((r) => String(r.source_type ?? '') === 'product');

  type Scored = { card: ProductCard; which: 1 | 2 };
  const scored: Scored[] = [];
  for (const card of cards) {
    const uk = productCardUrlKey(String(card.url ?? ''));
    const row = productRows.find((r) => productCardUrlKey(String(r.url ?? '')) === uk);
    const titles = [String(card.title ?? '').trim(), row ? String(row.title ?? '').trim() : ''].filter(
      (x) => x.length > 0
    );
    let which: 0 | 1 | 2 = 0;
    for (const tit of titles) {
      if (nameMatchesTitle(n1, tit)) {
        which = 1;
        break;
      }
      if (nameMatchesTitle(n2, tit)) {
        which = 2;
        break;
      }
    }
    if (which === 1 || which === 2) {
      scored.push({ card, which });
    }
  }
  if (scored.length === 0) return cards;

  const byWhich = (w: 1 | 2): ProductCard | undefined => {
    const first = scored.find((x) => x.which === w);
    return first?.card;
  };
  const c1 = byWhich(1);
  const c2 = byWhich(2);
  const out: ProductCard[] = [];
  if (c1) out.push(c1);
  if (c2 && (!c1 || productCardUrlKey(c1.url) !== productCardUrlKey(c2.url))) out.push(c2);
  return dedupeProductCardsByUrl(out);
}

/** Keep first occurrence per canonical URL so the UI does not repeat the same product card. */
export function dedupeProductCardsByUrl(cards: ProductCard[]): ProductCard[] {
  const seen = new Set<string>();
  const out: ProductCard[] = [];
  for (const card of cards) {
    const k = productCardUrlKey(card.url ?? '');
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(card);
  }
  return out;
}
