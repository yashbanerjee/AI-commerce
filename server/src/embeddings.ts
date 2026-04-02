import OpenAI from 'openai';
import { OPENAI_API_URL, OPENAI_EMBEDDING_MODEL } from './config.js';

export type EmbedResult = {
  embedding: number[];
  /** OpenAI embedding usage (prompt/total tokens). */
  promptTokens: number;
};

/**
 * Embeddings for catalog + query; uses shared API key (passed in from route after resolveOpenAiApiKey).
 */
export async function embedTextWithOpenAi(text: string, apiKey: string): Promise<EmbedResult> {
  const t = text.slice(0, 8000);
  const client = new OpenAI({ apiKey, baseURL: OPENAI_API_URL });
  const res = await client.embeddings.create({
    model: OPENAI_EMBEDDING_MODEL,
    input: t,
  });
  const v = res.data[0]?.embedding;
  if (!v) {
    throw new Error('openai_embed_empty');
  }
  const usage = res.usage;
  const promptTokens = usage?.total_tokens ?? usage?.prompt_tokens ?? 0;

  return { embedding: v, promptTokens };
}

/**
 * Batched embeddings helper: send multiple chunk texts in a single OpenAI request.
 * Returns one vector per input plus total token usage for cost tracking.
 */
export async function embedManyWithOpenAi(
  texts: string[],
  apiKey: string
): Promise<{ embeddings: number[][]; promptTokens: number }> {
  const cleaned = texts.map((t) => (t ?? '').slice(0, 8000));

  // Single-input fast path: reuse the existing helper for clarity and consistent errors.
  if (cleaned.length === 1) {
    const single = await embedTextWithOpenAi(cleaned[0] ?? '', apiKey);
    return { embeddings: [single.embedding], promptTokens: single.promptTokens };
  }

  const client = new OpenAI({ apiKey, baseURL: OPENAI_API_URL });
  try {
    const res = await client.embeddings.create({
      model: OPENAI_EMBEDDING_MODEL,
      input: cleaned,
    });
    const vectors = res.data
      .map((row) => row.embedding)
      .filter((v) => Array.isArray(v) && v.length > 0);

    // If OpenAI ever returns fewer rows than requested, fall back to per-chunk calls instead of failing ingest.
    if (vectors.length === cleaned.length) {
      const usage = res.usage;
      const promptTokens = usage?.total_tokens ?? usage?.prompt_tokens ?? 0;
      return { embeddings: vectors, promptTokens };
    }
  } catch {
    // Fall through to per-chunk calls below.
  }

  // Conservative fallback: embed each chunk one by one.
  let totalTokens = 0;
  const out: number[][] = [];
  for (const t of cleaned) {
    const { embedding, promptTokens } = await embedTextWithOpenAi(t, apiKey);
    totalTokens += promptTokens;
    out.push(embedding);
  }
  return { embeddings: out, promptTokens: totalTokens };
}
