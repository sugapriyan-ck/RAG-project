import { completeChat } from "../llm";
import { boundHistory, contextualizeQuestion } from "../chat/context";
import { buildAnswerMessages, noHitAnswer, resolveReplyLanguage, type ChatAnswerOptions } from "../chat/prompt";
import type { ChatLanguage } from "../chat/validation";
import {
  retrieveChunks,
  type RetrieveOptions,
  type RetrievedChunk,
} from "./retrieve";

export interface RagSource {
  documentId: string;
  documentName: string;
  similarity: number;
}

export interface RagAnswer {
  answer: string;
  usedKnowledgeBase: boolean;
  sources: RagSource[];
  retrieval: RetrievedChunk[];
  // The language the reply was written in (mirrors the customer's language).
  language: ChatLanguage | null;
}

export { SYSTEM_PROMPT } from "../chat/prompt";

export interface AnswerOptions extends RetrieveOptions, ChatAnswerOptions {}

export async function answerQuestion(
  userQuestion: string,
  options: AnswerOptions = {},
): Promise<RagAnswer> {
  const history = boundHistory(options.history ?? []);
  const language = resolveReplyLanguage(userQuestion, options);
  const retrieval = await retrieveChunks(contextualizeQuestion(userQuestion, history), options);

  if (retrieval.length === 0) {
    return {
      answer: noHitAnswer(userQuestion, language ?? undefined),
      usedKnowledgeBase: false,
      sources: [],
      retrieval: [],
      language,
    };
  }

  const context = retrieval
    .map((chunk, i) => `[Passage ${i + 1} — ${chunk.documentName}]\n${chunk.content}`)
    .join("\n\n");
  const messages = buildAnswerMessages(userQuestion, context, { ...options, history });
  const answer = await completeChat(messages, { maxTokens: options.voice ? 256 : 512 });

  return {
    answer,
    usedKnowledgeBase: true,
    sources: retrieval.map((chunk) => ({
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      similarity: chunk.similarity,
    })),
    retrieval,
    language,
  };
}
