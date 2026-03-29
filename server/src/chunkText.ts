export interface TextChunk {
  index: number;
  text: string;
}

const MAX_CHARS = 1400;
const OVERLAP = 120;

export function chunkText(fullText: string): TextChunk[] {
  const normalized = fullText.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= MAX_CHARS) {
      pieces.push(p);
      continue;
    }
    let start = 0;
    while (start < p.length) {
      const end = Math.min(p.length, start + MAX_CHARS);
      pieces.push(p.slice(start, end));
      if (end >= p.length) break;
      start = end - OVERLAP;
      if (start < 0) start = 0;
    }
  }

  return pieces.map((text, index) => ({ index, text }));
}
