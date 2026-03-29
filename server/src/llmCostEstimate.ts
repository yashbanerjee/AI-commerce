import {
  COST_CHAT_INPUT_USD_PER_MILLION,
  COST_CHAT_OUTPUT_USD_PER_MILLION,
  COST_EMBED_USD_PER_MILLION,
  OPENAI_CHAT_MODEL,
  OPENAI_EMBEDDING_MODEL,
} from './config.js';

/** USD per 1M tokens for embedding models (approximate list prices). */
const EMBED_USD_PER_MILLION: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.1,
};

/** USD per 1M tokens: input (prompt) and output (completion). Approximate; update when OpenAI changes pricing. */
const CHAT_USD_PER_MILLION: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4-turbo': { in: 10, out: 30 },
  'gpt-4-turbo-preview': { in: 10, out: 30 },
  'gpt-4': { in: 30, out: 60 },
  'gpt-3.5-turbo': { in: 0.5, out: 1.5 },
  'gpt-3.5-turbo-0125': { in: 0.5, out: 1.5 },
  'o1-mini': { in: 3, out: 12 },
  'o1-preview': { in: 15, out: 60 },
  'o3-mini': { in: 1.1, out: 4.4 },
};

const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';

function normModel(id: string): string {
  return id.trim().toLowerCase();
}

function embedRatePerMillion(model: string): { usd: number; source: 'env' | 'table' | 'fallback' } {
  if (COST_EMBED_USD_PER_MILLION !== undefined) {
    return { usd: COST_EMBED_USD_PER_MILLION, source: 'env' };
  }
  const key = normModel(model);
  const hit = EMBED_USD_PER_MILLION[key];
  if (hit !== undefined) {
    return { usd: hit, source: 'table' };
  }
  return {
    usd: EMBED_USD_PER_MILLION[DEFAULT_EMBED_MODEL] ?? 0.02,
    source: 'fallback',
  };
}

function chatRatesPerMillion(model: string): {
  inputUsd: number;
  outputUsd: number;
  source: 'env' | 'table' | 'fallback';
} {
  if (
    COST_CHAT_INPUT_USD_PER_MILLION !== undefined &&
    COST_CHAT_OUTPUT_USD_PER_MILLION !== undefined
  ) {
    return {
      inputUsd: COST_CHAT_INPUT_USD_PER_MILLION,
      outputUsd: COST_CHAT_OUTPUT_USD_PER_MILLION,
      source: 'env',
    };
  }
  const key = normModel(model);
  const hit = CHAT_USD_PER_MILLION[key];
  if (hit !== undefined) {
    return { inputUsd: hit.in, outputUsd: hit.out, source: 'table' };
  }
  const fb = CHAT_USD_PER_MILLION[DEFAULT_CHAT_MODEL] ?? { in: 0.15, out: 0.6 };
  return { inputUsd: fb.in, outputUsd: fb.out, source: 'fallback' };
}

export type OpenAiCostEstimate = {
  estimated_embed_usd: number;
  estimated_chat_input_usd: number;
  estimated_chat_output_usd: number;
  estimated_openai_usd_total: number;
};

export function estimateOpenAiCostUsd(params: {
  embed_tokens: number;
  chat_prompt_tokens: number;
  chat_completion_tokens: number;
  chat_model?: string;
  embedding_model?: string;
}): OpenAiCostEstimate {
  const chatModel = params.chat_model ?? OPENAI_CHAT_MODEL;
  const embedModel = params.embedding_model ?? OPENAI_EMBEDDING_MODEL;

  const er = embedRatePerMillion(embedModel);
  const cr = chatRatesPerMillion(chatModel);

  const embed = (Math.max(0, params.embed_tokens) / 1_000_000) * er.usd;
  const chatIn = (Math.max(0, params.chat_prompt_tokens) / 1_000_000) * cr.inputUsd;
  const chatOut = (Math.max(0, params.chat_completion_tokens) / 1_000_000) * cr.outputUsd;

  return {
    estimated_embed_usd: roundUsd(embed),
    estimated_chat_input_usd: roundUsd(chatIn),
    estimated_chat_output_usd: roundUsd(chatOut),
    estimated_openai_usd_total: roundUsd(embed + chatIn + chatOut),
  };
}

function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export type CostEstimateMeta = {
  chat_model: string;
  embedding_model: string;
  pricing_note: string;
};

export function openAiCostEstimateMeta(): CostEstimateMeta {
  return {
    chat_model: OPENAI_CHAT_MODEL,
    embedding_model: OPENAI_EMBEDDING_MODEL,
    pricing_note:
      'Approximate USD from token counts (last 30 days for per-tenant) using public-style list rates for the configured models. Does not include discounts, cached tokens, or non-OpenAI spend. Override rates with COST_EMBED_USD_PER_MILLION, COST_CHAT_INPUT_USD_PER_MILLION, COST_CHAT_OUTPUT_USD_PER_MILLION.',
  };
}
