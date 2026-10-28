export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export const HISTORY_LIMIT = 8;
export const HISTORY_CHARACTER_LIMIT = 6000;
export const HISTORY_MESSAGE_LIMIT = 1500;

// Input is chronological; keep the newest usable messages within both bounds.
export function boundHistory(rows: readonly unknown[]): HistoryMessage[] {
  const result: HistoryMessage[] = [];
  let remaining = HISTORY_CHARACTER_LIMIT;
  for (let i = rows.length - 1; i >= 0 && result.length < HISTORY_LIMIT && remaining > 0; i--) {
    const row = rows[i] as Partial<HistoryMessage> | null;
    if (!row || (row.role !== "user" && row.role !== "assistant") || typeof row.content !== "string") continue;
    const content = row.content.trim().slice(0, Math.min(HISTORY_MESSAGE_LIMIT, remaining));
    if (!content) continue;
    result.push({ role: row.role, content });
    remaining -= content.length;
  }
  return result.reverse();
}

// Only explicit references/elliptical followups borrow context. A new short
// question such as "What is your return policy?" must remain independent.
export function contextualizeQuestion(question: string, history: readonly HistoryMessage[]): string {
  const current = question.trim();
  const followup = current.length <= 180 && (
    /\b(it|that|this|those|these|them|same)\b/i.test(current) ||
    /^(and\b|what about\b|how about\b|how (long|much)\b|when\b|why\b|aur\b|uska\b|iska\b|athu\b|adhu\b|appo\b|adi\b|adu\b)/i.test(current) ||
    /^(और|उसका|इसका|वह|यह|அது|அதை|அப்போ|அதற்கு|అది|దాని|మరి|ಅದು|ಅದರ|ಹಾಗಾದರೆ|അത്|അതിന്|അപ്പോൾ)/u.test(current)
  );
  if (!followup) return current;
  const previous = [...history].reverse().find((turn) => turn.role === "user");
  return previous ? `Previous customer question: ${previous.content.slice(0, 600)}\nFollow-up question: ${current}` : current;
}
