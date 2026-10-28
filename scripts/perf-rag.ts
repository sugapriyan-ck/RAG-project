process.loadEnvFile(".env.local");
import { createClient } from "@supabase/supabase-js";
import { embedQuery } from "../lib/embeddings/index";
import { completeChat } from "../lib/llm/index";
import { SYSTEM_PROMPT } from "../lib/rag/answer";

interface Case {
  query: string;
  lang: string;
  expected: string; // fuzzy topic hint
}

const CASES: Case[] = [
  { query: "Enoda order eppo varum?", lang: "Tamil (Tanglish)", expected: "delivery/tracking" },
  { query: "Mera refund kab tak aayega?", lang: "Hindi (Hinglish)", expected: "refund" },
  { query: "Na order ekkada undi?", lang: "Telugu (Roman)", expected: "delivery/tracking" },
  { query: "Nanna order yavaga barutte?", lang: "Kannada (Roman)", expected: "delivery/tracking" },
  { query: "Ente order eppol varum?", lang: "Malayalam (Roman)", expected: "delivery/tracking" },
  { query: "When will my order arrive?", lang: "English", expected: "delivery/tracking" },
  { query: "How do I return a product?", lang: "English", expected: "returns" },
  { query: "I want to cancel my order", lang: "English", expected: "cancellation" },
];

const MS = 0.22;
const TOP_K = 5;

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("Embedded snippets (KB, from existing index):");
  let embedTotal = 0;
  const rows: string[] = [];

  for (const c of CASES) {
    const t0 = performance.now();
    const vec = await embedQuery(c.query);
    const t1 = performance.now();
    const { data } = await sb.rpc("match_documents", {
      query_embedding: vec,
      match_count: TOP_K,
      match_threshold: MS,
    });
    const t2 = performance.now();

    const hits = (data ?? []) as Array<{
      document_name: string;
      chunk_content: string;
      similarity: number;
    }>;
    const top = hits[0];
    const hitTopics = hits.map((h) => h.chunk_content.slice(0, 40).replace(/\s+/g, " ")).join(" | ");

    // LLM stage (same prompt recipe as answer.ts)
    const context = hits
      .map((ch, i) => `[Passage ${i + 1} — ${ch.document_name}]\n${ch.chunk_content}`)
      .join("\n\n");
    const t3 = performance.now();
    let answerLen = 0;
    if (hits.length > 0) {
      const answer = await completeChat([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Knowledge-base passages:\n\n${context}\n\nCustomer question:\n${c.query}` },
      ]);
      answerLen = answer.length;
    }
    const t4 = performance.now();

    embedTotal += t1 - t0;
    rows.push(
      `${c.lang.padEnd(20)} top:${(top?.similarity ?? 0).toFixed(3).padStart(5)} ` +
        `${(top?.document_name ?? "NO-HIT").padEnd(28)} ` +
        `embed=${(t1 - t0).toFixed(0).padStart(3)}ms rpc=${(t2 - t1).toFixed(0).padStart(3)}ms ` +
        `llm=${(t4 - t3).toFixed(0).padStart(3)}ms total=${(t4 - t0).toFixed(0).padStart(3)}ms ` +
        `ansLen=${answerLen} | ${hitTopics.slice(0, 60)}`,
    );
  }

  console.log(rows.join("\n"));
  console.log(`\navg embed per query: ${(embedTotal / CASES.length).toFixed(0)}ms`);
  console.log(`model: BAAI/bge-m3 (1024-dim)  threshold=${MS} topK=${TOP_K}`);
  console.log(`llm: google/gemini-3.1-flash-lite via OpenRouter`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});