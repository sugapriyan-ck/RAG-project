process.loadEnvFile(".env.local");
import { answerQuestion } from "../lib/rag/answer";

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('Usage: npm run rag -- "your question"');
    process.exit(1);
  }

  const result = await answerQuestion(question);

  console.log(`ANSWER: ${result.answer}`);
  console.log(`usedKnowledgeBase: ${result.usedKnowledgeBase}`);
  for (const source of result.sources) {
    console.log(
      `  source: ${source.documentName} (similarity ${source.similarity.toFixed(3)})`,
    );
  }
}

main().catch((error) => {
  console.error(
    "RAG test failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});