import OpenAI from 'openai';
import {
  CHAT_COMPLETION_MAX_TOKENS,
  LOG_LLM_IO,
  OPENAI_API_URL,
  OPENAI_CHAT_MODEL,
  CHAT_PRODUCT_CARDS_MAX,
} from './config.js';

/** Official OpenAI Chat Completions supports json_object; many proxies do not. */
function useJsonObjectMode(): boolean {
  const u = OPENAI_API_URL.toLowerCase();
  return u.includes('api.openai.com');
}

export interface Citation {
  title: string;
  url: string;
  source_type: string;
  id: string;
}

export interface ProductCard {
  title: string;
  url: string;
  price_text: string;
  /** Optional offer/discount label (e.g. "On sale"). */
  offer_text?: string;
  /** Product thumbnail (https URL), from CONTEXT or filled server-side from index metadata. */
  image_url: string;
}

export interface ChatJsonResult {
  /** Section (1): main answer text. */
  answer: string;
  /** Section (3): closing statement / follow-up question, plain text. */
  closing_text?: string;
  citations: Citation[];
  suggestions: string[];
  product_cards: ProductCard[];
}

export type ChatWithUsage = ChatJsonResult & {
  promptTokens: number;
  completionTokens: number;
};

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Chat completion with shared API key; returns token usage for per-tenant accounting.
 */
export async function generateAnswerWithOpenAi(
  messages: ChatMessage[],
  apiKey: string,
  maxOutputTokens: number = CHAT_COMPLETION_MAX_TOKENS
): Promise<ChatWithUsage> {
  const client = new OpenAI({ apiKey, baseURL: OPENAI_API_URL });
  if (LOG_LLM_IO) {
    const sep = '\n' + '='.repeat(72) + '\n';
    let promptDump = `${sep}[llm] PROMPT — ${messages.length} message(s) (sent to ${OPENAI_CHAT_MODEL})${sep}`;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      promptDump += `--- #${i + 1} role=${m.role} (${m.content.length} chars) ---\n${m.content}\n\n`;
    }
    // eslint-disable-next-line no-console
    console.log(promptDump.trimEnd());
  }

  const res = await client.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    temperature: 0.25,
    max_tokens: maxOutputTokens,
    messages,
    ...(useJsonObjectMode() ? { response_format: { type: 'json_object' as const } } : {}),
  });
  const text = res.choices[0]?.message?.content ?? '';
  if (LOG_LLM_IO) {
    const sep = '\n' + '='.repeat(72) + '\n';
    // eslint-disable-next-line no-console
    console.log(
      `${sep}[llm] RAW COMPLETION (${text.length} chars)${sep}${text}${sep}[llm] END RAW COMPLETION${sep}`
    );
  }
  const u = res.usage;
  const parsed = parseJsonResponse(text);

  return {
    ...parsed,
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
  };
}

function normalizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title : '';
    const url = typeof o.url === 'string' ? o.url : '';
    const source_type = typeof o.source_type === 'string' ? o.source_type : '';
    const id = typeof o.id === 'string' ? o.id : '';
    if (!title && !url) continue;
    out.push({ title, url, source_type, id });
  }
  return out;
}

function suggestionItemToString(s: unknown): string {
  if (typeof s === 'string') return s.trim();
  if (!s || typeof s !== 'object') return '';
  const o = s as Record<string, unknown>;
  for (const k of ['text', 'label', 'title', 'suggestion', 'query', 'message']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/**
 * Suggestion chips must read as the shopper's next message, not the assistant asking them questions.
 */
function looksLikeAssistantPhrasedSuggestion(t: string): boolean {
  const s = t.trim();
  if (s.length < 4) return false;
  return (
    /^(can|may)\s+i\s+(help|assist|offer|get|show|find|recommend)\b/i.test(s) ||
    /^would\s+you\s+like\b/i.test(s) ||
    /^are\s+you\s+interested\b/i.test(s) ||
    /^shall\s+i\b/i.test(s) ||
    /^do\s+you\s+want\s+me\s+to\b/i.test(s) ||
    /^is\s+there\s+anything\s+else\b/i.test(s) ||
    /^need\s+help\s+with\s+anything\b/i.test(s) ||
    /^can\s+i\s+help\s+you\s+with\b/i.test(s) ||
    /^would\s+you\s+like\s+to\s+know\s+more\b/i.test(s) ||
    /^do\s+you\s+have\s+any\s+other\s+health\s+goals\b/i.test(s) ||
    /^do\s+you\s+have\s+any\s+dietary\s+restrictions\b/i.test(s)
  );
}

function normalizeSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    const t = suggestionItemToString(s).replace(/\s+/g, ' ').slice(0, 72);
    if (t.length < 2) continue;
    if (looksLikeAssistantPhrasedSuggestion(t)) continue;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeProductCards(raw: unknown): ProductCard[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductCard[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const titleRaw =
      typeof o.title === 'string'
        ? o.title
        : typeof o.name === 'string'
          ? o.name
          : '';
    const title = titleRaw.trim().slice(0, 200);
    let url =
      typeof o.url === 'string'
        ? o.url.trim()
        : typeof o.link === 'string'
          ? o.link.trim()
          : typeof o.href === 'string'
            ? o.href.trim()
            : '';
    if (!title || !url) continue;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) continue;
    const price_text =
      typeof o.price_text === 'string'
        ? o.price_text.trim().slice(0, 80)
        : typeof o.priceText === 'string'
          ? o.priceText.trim().slice(0, 80)
          : '';
    const offer_text =
      typeof o.offer_text === 'string'
        ? o.offer_text.trim().slice(0, 80)
        : typeof o.offerText === 'string'
          ? o.offerText.trim().slice(0, 80)
          : '';
    const iuRaw = o.image_url ?? o.imageUrl ?? o.image ?? o.thumbnail;
    let image_url = '';
    if (typeof iuRaw === 'string') {
      let iu = iuRaw.trim();
      if (iu.startsWith('//')) iu = `https:${iu}`;
      if (/^https?:\/\//i.test(iu)) image_url = iu.slice(0, 2000);
    }
    out.push({ title, url, price_text, offer_text: offer_text || undefined, image_url });
    if (out.length >= CHAT_PRODUCT_CARDS_MAX) break;
  }
  return out;
}

function firstArray(...candidates: unknown[]): unknown[] | undefined {
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return undefined;
}

function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  return m ? m[1].trim() : t;
}

function parseJsonResponse(text: string): ChatJsonResult {
  const empty: ChatJsonResult = {
    answer: '',
    closing_text: '',
    citations: [],
    suggestions: [],
    product_cards: [],
  };
  const trimmed = stripCodeFences(text.trim());
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const answer = typeof parsed.answer === 'string' ? parsed.answer : '';
    const closing_text =
      typeof parsed.closing_text === 'string'
        ? parsed.closing_text
        : typeof parsed.closing === 'string'
          ? parsed.closing
          : typeof parsed.followup_text === 'string'
            ? parsed.followup_text
            : typeof parsed.followup === 'string'
              ? parsed.followup
              : '';
    const sugRaw = firstArray(
      parsed.suggestions,
      parsed.Suggestions,
      parsed.follow_ups,
      parsed.followUps
    );
    const cardsRaw = firstArray(parsed.product_cards, parsed.productCards, parsed.ProductCards);
    if (!answer) {
      return {
        answer: trimmed,
        closing_text: closing_text || '',
        citations: normalizeCitations(parsed.citations),
        suggestions: normalizeSuggestions(sugRaw),
        product_cards: normalizeProductCards(cardsRaw),
      };
    }
    return {
      answer,
      closing_text: closing_text || '',
      citations: normalizeCitations(parsed.citations),
      suggestions: normalizeSuggestions(sugRaw),
      product_cards: normalizeProductCards(cardsRaw),
    };
  } catch {
    return { ...empty, answer: trimmed };
  }
}
