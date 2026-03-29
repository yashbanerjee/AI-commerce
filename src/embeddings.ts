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
