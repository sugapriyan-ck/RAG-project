export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function completeChat(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const model = process.env.LLM_MODEL;
  if (!model) throw new Error("LLM_MODEL is not set in .env.local");

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: isVoiceRequest(messages) ? Math.min(options.maxTokens ?? 512, 160) : options.maxTokens ?? 512,
    temperature: options.temperature ?? 0.4,
  };
  addConfiguredProvider(body);

  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "RAG Support",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: options.signal,
  });

  if (!res.ok) {
    throw new Error(`OpenRouter chat request failed (${res.status})`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenRouter chat returned an empty response");

  return content;
}

function isVoiceRequest(messages: LlmMessage[]) {
  return messages.some((message) => message.role === "system" && message.content.includes("spoken aloud"));
}

function addConfiguredProvider(body: Record<string, unknown>) {
  // Throughput is the latency-oriented default; deployments can set an
  // explicit empty value only by changing this helper in code, not from the
  // browser. OpenRouter still chooses among the configured model's providers.
  const sort = process.env.OPENROUTER_PROVIDER_SORT || "throughput";
  if (sort === "throughput") {
    body.provider = { sort: "throughput" };
  }
}

interface OpenRouterChunk {
  error?: unknown;
  choices?: { delta?: { content?: unknown } }[];
}

function chunkText(chunk: OpenRouterChunk) {
  const content = chunk.choices?.[0]?.delta?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")
      .join("");
  }
  return "";
}

/** Parse OpenRouter's line-oriented SSE response without exposing provider payloads. */
export async function* parseOpenRouterSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let dataLines: string[] = [];
  const parseEvent = function* (): Generator<string> {
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data) return;
    if (data === "[DONE]") {
      finished = true;
      return;
    }
    let chunk: OpenRouterChunk;
    try {
      chunk = JSON.parse(data) as OpenRouterChunk;
    } catch {
      // Ignore malformed provider events without relaying raw payloads.
      return;
    }
    if (chunk.error) throw new Error("OpenRouter stream failed");
    const text = chunkText(chunk);
    if (text) yield text;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        if (line === "") yield* parseEvent();
        if (finished) return;
      }
      if (done) {
        if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
        yield* parseEvent();
        break;
      }
    }
    if (!finished) throw new Error("OpenRouter stream ended unexpectedly");
  } finally {
    if (finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function completeChatStream(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<AsyncIterable<string>> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const model = process.env.LLM_MODEL;
  if (!model) throw new Error("LLM_MODEL is not set in .env.local");

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options.maxTokens ?? 512,
    temperature: options.temperature ?? 0.4,
    stream: true,
  };
  addConfiguredProvider(body);
  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "RAG Support",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: options.signal,
  });
  if (!res.ok || !res.body) throw new Error(`OpenRouter chat request failed (${res.status})`);
  return parseOpenRouterSse(res.body);
}
