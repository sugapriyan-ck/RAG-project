const messages = {
  invalid: "Invalid chat request. Shorten your question or start a new chat and try again.",
  conversation: "This conversation is unavailable. Start a new chat and try again.",
  rateLimit: "Too many requests. Please wait before trying again.",
  backend: "The chat backend is unavailable. Please try again later; text chat may also fail.",
  connection: "Could not connect to chat. Check your connection and try again.",
  busy: "Please wait for the current request to finish.",
  empty: "No reply was received. Please try again.",
  unknown: "The chat request failed. Please try again later.",
} as const;

/** Only application-selected codes may cross the request/UI error boundary. */
export class ChatRequestError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "ChatRequestError";
  }
}

export function httpRequestError(status: number): ChatRequestError {
  const code = status === 400 ? "invalid" : status === 403 ? "conversation"
    : status === 429 ? "rateLimit" : status >= 500 && status <= 599 ? "backend" : "unknown";
  return new ChatRequestError(code);
}

export function requestErrorMessage(error: unknown): string {
  // Never trust Error.message, including a subsequently modified typed error.
  return error instanceof ChatRequestError && Object.hasOwn(messages, error.code)
    ? messages[error.code] : messages.unknown;
}

export function isRequestAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
