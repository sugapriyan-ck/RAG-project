import { PDFParse } from "pdf-parse";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

export type SupportedMime =
  | "application/pdf"
  | "text/plain"
  | "text/markdown";

export function mimeFromFilename(name: string): string | undefined {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? MIME_BY_EXT[ext] : undefined;
}

export function isSupportedMime(mime: string | undefined): mime is SupportedMime {
  return (
    mime === "application/pdf" ||
    mime === "text/plain" ||
    mime === "text/markdown"
  );
}

// Always returns the on-disk content as a string. Throws on unsupported types
// or unreadable files.
export async function extractText(buffer: Buffer, mime: string): Promise<string> {
  switch (mime) {
    case "application/pdf": {
      const parser = new PDFParse({ data: buffer });
      const { text } = await parser.getText();
      if (!text || text.trim().length === 0) {
        throw new Error("PDF produced no extractable text (is it a scanned image?)");
      }
      return text;
    }
    case "text/plain":
    case "text/markdown":
      return buffer.toString("utf8");
    default:
      throw new Error(`Unsupported mime type: ${mime}`);
  }
}