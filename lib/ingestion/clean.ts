// Reduce PDF/OCR noise without altering meaning: normalize line endings,
// collapse runs of blank lines and loose whitespace, keep paragraph breaks.
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/[ \t]+\n/g, "\n") // trailing spaces before newline
    .replace(/[ \t]{2,}/g, " ") // double+ spaces inside a line
    .replace(/\u00a0/g, " ") // non-breaking space
    .replace(/\n{3,}/g, "\n\n") // collapse blank runs
    .trim();
}