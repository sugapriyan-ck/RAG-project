process.loadEnvFile(".env.local");
import { createClient } from "@supabase/supabase-js";
import { embedQuery } from "../lib/embeddings/index";

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  const q = await embedQuery(question);
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await sb.rpc("match_documents", {
    query_embedding: q,
    match_count: 10,
    match_threshold: 0,
  });
  if (error) {
    console.error("ERR", error);
    process.exit(1);
  }
  console.log(`question: ${question}`);
  for (const r of data) {
    console.log(r.similarity.toFixed(4), "|", r.document_name, "|", r.chunk_content.replace(/\s+/g, " ").slice(0, 100));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});