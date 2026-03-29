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

function urlMatchKey(u: string): string {
  const t = u.trim();
  if (!t) return '';
  try {
    const parsed = /^https?:\/\//i.test(t) ? new URL(t) : new URL(t, 'https://placeholder.local');
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return t.replace(/\/$/, '').toLowerCase();
  }
}

function titleMatchKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
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
    const uk = urlMatchKey(r.url);
    if (uk) imageByUrl.set(uk, img);
    const tk = titleMatchKey(r.title);
    if (tk) imageByTitle.set(tk, img);
  }

  return cards.map((card) => {
    let imageUrl = normalizeImageUrlString(card.image_url ?? '');
    if (imageUrl) {
      return { ...card, image_url: imageUrl };
    }
    const uk = urlMatchKey(card.url);
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
