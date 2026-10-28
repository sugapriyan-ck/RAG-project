export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

export interface Chunk {
  seq: number;
  content: string;
}

const DEFAULT_MAX = 1200;
const DEFAULT_OVERLAP = 150;

// Split a paragraph longer than maxChars at sentence/line/word boundaries.
// Each new tail keeps an overlap of the previous tail so no context is lost.
function splitLong(text: string, maxChars: number, overlapChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;

  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars);
    let at = head.lastIndexOf(". ");
    if (at < maxChars * 0.5) at = head.lastIndexOf("; ");
    if (at < maxChars * 0.5) at = head.lastIndexOf("\n");
    if (at < maxChars * 0.5) at = head.lastIndexOf(" ");
    if (at < maxChars * 0.5) at = maxChars;

    const cut = Math.max(1, at + 1);
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(Math.max(0, cut - overlapChars)).trimStart();
  }
  if (rest) pieces.push(rest);

  return pieces.filter((p) => p.length > 0);
}

// Greedily pack paragraphs into chunks up to maxChars; oversized paragraphs
// are spliced separately with overlap.
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = Math.max(100, options.maxChars ?? DEFAULT_MAX);
  const overlapChars = Math.min(options.overlapChars ?? DEFAULT_OVERLAP, Math.floor(maxChars / 2));

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const chunks: string[] = [];

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      chunks.push(...splitLong(para, maxChars, overlapChars));
      continue;
    }

    const lastIdx = chunks.length - 1;
    const last = chunks[lastIdx];
    if (last && last.length + para.length + 2 <= maxChars) {
      chunks[lastIdx] = `${last}\n\n${para}`;
    } else {
      chunks.push(para);
    }
  }

  return chunks
    .filter((c) => c.trim().length > 0)
    .map((content, seq) => ({ seq, content: content.trim() }));
}