// Opt-in live probe: creates one synthetic support conversation. Never prints
// credentials, conversation handles, user data, request bodies, or raw errors.
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { lookup } from "node:dns/promises";

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* Environment may be supplied externally. */ }
  const required = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY", "LLM_MODEL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.log(JSON.stringify({ missingConfiguration: missing }));
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--connectivity-only")) {
    const configured = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    console.log(JSON.stringify({ https: configured.protocol === "https:", looksLikePlaceholder: /your[-_.]|placeholder|example/i.test(configured.hostname) }));
    for (const [service, host] of [["supabase", configured.hostname], ["openrouter", "openrouter.ai"], ["dns-control", "example.com"]]) {
      try { await lookup(host); console.log(JSON.stringify({ service, dns: "resolved" })); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        console.log(JSON.stringify({ service, dns: "failed", code: code && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined }));
        process.exitCode = 1;
      }
    }
    return;
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // Only label known service operations, never print arbitrary URLs/querystrings.
    const operation = url.pathname.match(/\/(conversations|messages|support_events|match_documents|embeddings|completions)$/)?.[1] ?? "service";
    try {
      const response = await original(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20000) });
      let code: string | undefined;
      if (!response.ok) {
        const payload = await response.clone().json().catch(() => ({}));
        const candidate = payload.code ?? payload.error?.code;
        if (typeof candidate === "number" || (typeof candidate === "string" && /^[A-Z0-9_]{1,30}$/.test(candidate))) code = String(candidate);
      }
      console.log(JSON.stringify({ operation, status: response.status, code }));
      return response;
    } catch (error) {
      const cause = error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined;
      const networkCode = typeof cause?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : undefined;
      console.log(JSON.stringify({ operation, failure: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network", networkCode }));
      throw error;
    }
  };
  try {
    const response = await POST(new NextRequest("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "How do I return a product?", conversationId: null, visitorKey: null, language: "en-IN", voice: true }),
      headers: { "Content-Type": "application/json" },
    }));
    const result = await response.json();
    console.log(JSON.stringify({ resultStatus: response.status, hasAnswer: typeof result.answer === "string", hasConversation: !!result.conversationId }));
    if (!response.ok) process.exitCode = 1;
  } finally { globalThis.fetch = original; }
}

main().catch(() => { console.error("Diagnostic could not finish; no private error details printed."); process.exitCode = 1; });
