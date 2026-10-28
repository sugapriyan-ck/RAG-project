export const CHAT_LANGUAGES = ["en-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN"] as const;
export type ChatLanguage = (typeof CHAT_LANGUAGES)[number];
export const MAX_MESSAGE_LENGTH = 4000;

export interface ConversationHandles {
  conversationId?: string;
  visitorKey?: string;
}

export interface ChatRequest extends ConversationHandles {
  message: string;
  language?: ChatLanguage;
  voice: boolean;
}

type Validation<T> = { value: T; error?: never } | { error: string; value?: never };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateHandles(conversationId: unknown, visitorKey: unknown, required = false): Validation<ConversationHandles> {
  if (conversationId == null && visitorKey == null && !required) return { value: {} };
  if (typeof conversationId !== "string" || typeof visitorKey !== "string" || !UUID.test(conversationId) || !UUID.test(visitorKey)) {
    return { error: "conversationId and visitorKey must be provided together as UUIDs" };
  }
  return { value: { conversationId, visitorKey } };
}

export function validateChatRequest(body: unknown): Validation<ChatRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "JSON body must be an object" };
  const input = body as Record<string, unknown>;
  if (typeof input.message !== "string" || !input.message.trim()) return { error: "message is required and must be a string" };
  const message = input.message.trim();
  if (message.length > MAX_MESSAGE_LENGTH) return { error: `message is too long (max ${MAX_MESSAGE_LENGTH} characters)` };
  const handles = validateHandles(input.conversationId, input.visitorKey);
  if (handles.error) return { error: handles.error };
  if (input.language !== undefined && !CHAT_LANGUAGES.includes(input.language as ChatLanguage)) return { error: "language must be one of en-IN, hi-IN, ta-IN, te-IN, kn-IN, ml-IN" };
  if (input.voice !== undefined && typeof input.voice !== "boolean") return { error: "voice must be a boolean" };
  return { value: { ...handles.value, message, language: input.language as ChatLanguage | undefined, voice: input.voice === true } };
}
