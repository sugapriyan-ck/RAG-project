"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useVoiceSession, type VoiceEngine } from "@/lib/voice/use-voice-session";
import { ChatRequestError, httpRequestError, isRequestAbort, requestErrorMessage } from "@/lib/voice/request-error";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const CONV_KEY = "asr_conv_id";
const KEY_KEY = "asr_visitor_key";
const LANGUAGES = [
  { code: "en-IN", label: "English (India)" },
  { code: "hi-IN", label: "हिन्दी · Hindi" },
  { code: "ta-IN", label: "தமிழ் · Tamil" },
  { code: "te-IN", label: "తెలుగు · Telugu" },
  { code: "kn-IN", label: "ಕನ್ನಡ · Kannada" },
  { code: "ml-IN", label: "മലയാളം · Malayalam" },
];
const SUGGESTIONS = ["Where is my order?", "Mera refund kab tak aayega?", "How do I return a product?"];
const LANGUAGE_CODES = new Set(LANGUAGES.map((item) => item.code));
const PHASE_LABELS = {
  idle: "Ready when you are",
  listening: "Listening to you…",
  thinking: "Thinking about your question…",
  speaking: "Your assistant is speaking…",
  paused: "Conversation paused",
};

function nextId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

function aborted() {
  return new DOMException("Conversation stopped", "AbortError");
}

type StreamPayload = Record<string, unknown>;

function streamPayload(value: unknown): StreamPayload {
  return value && typeof value === "object" ? value as StreamPayload : {};
}

function streamEventKind(event: string, payload: StreamPayload) {
  const type = typeof payload.type === "string" ? payload.type : "";
  return type || event || "message";
}

function streamToken(event: string, payload: StreamPayload, raw: string) {
  const kind = streamEventKind(event, payload);
  if (kind !== "token" && kind !== "message" && kind !== "delta") return null;
  for (const key of ["token", "delta", "text", "content"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return typeof payload.type === "string" ? null : raw;
}

function streamError(payload: StreamPayload) {
  const status = typeof payload.status === "number" ? payload.status : 500;
  return httpRequestError(status);
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [language, setLanguage] = useState("en-IN");
  const [engine, setEngine] = useState<VoiceEngine>("browser");
  const [serverVoice, setServerVoice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const restoreRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const restoringRef = useRef(true);
  const engineTouched = useRef(false);
  const handles = useRef<{ conversationId: string | null; visitorKey: string | null }>({ conversationId: null, visitorKey: null });
  const mounted = useRef(false);
  const voice = useVoiceSession({
    language,
    engine,
    onTurn: (text: string, signal: AbortSignal, spokenLanguage?: string) => send(text, true, signal, spokenLanguage),
    onTranscript: setTranscript,
  });
  const voiceRunning = voice.active && voice.phase !== "paused";

  useEffect(() => {
    let active = true;
    fetch("/api/voice/capabilities")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!active || !data || typeof data !== "object") return;
        const flags = data as { speechToText?: unknown; textToSpeech?: unknown };
        const available = flags.speechToText === true && flags.textToSpeech === true;
        setServerVoice(available);
        if (available && !engineTouched.current) setEngine("server");
      })
      .catch(() => { /* Keep the browser engine when capabilities are unknown. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    const ticket = generation.current;
    const controller = new AbortController();
    restoreRequest.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    const current = () => !cancelled && ticket === generation.current;
    async function restore() {
      try {
        const conversationId = localStorage.getItem(CONV_KEY);
        const visitorKey = localStorage.getItem(KEY_KEY);
        handles.current = { conversationId, visitorKey };
        if (!conversationId || !visitorKey) return;
        const res = await fetch(`/api/chat?conversationId=${encodeURIComponent(conversationId)}&visitorKey=${encodeURIComponent(visitorKey)}`, { signal: controller.signal });
        if (!current()) return;
        if (res.status === 404 || res.status === 403) {
          handles.current = { conversationId: null, visitorKey: null };
          localStorage.removeItem(CONV_KEY);
          localStorage.removeItem(KEY_KEY);
          return;
        }
        if (!res.ok) throw new Error("History unavailable");
        const data = await res.json();
        if (!current()) return;
        if (!Array.isArray(data.messages)) throw new Error("Invalid history");
        setMessages(data.messages.filter((m: unknown): m is ChatMessage => !!m && typeof m === "object" && "content" in m && typeof m.content === "string" && "role" in m && (m.role === "assistant" || m.role === "user")).map((m: ChatMessage) => ({ id: nextId(), role: m.role, content: m.content })));
      } catch {
        if (current()) setError("Could not restore previous messages. Your conversation keys have been kept; continue chatting or reload to retry.");
      } finally {
        clearTimeout(timer);
        if (current()) {
          restoringRef.current = false;
          setRestoring(false);
          restoreRequest.current = null;
        }
      }
    }
    void restore();
    return () => {
      cancelled = true;
      mounted.current = false;
      controller.abort();
      request.current?.abort();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, busy]);

  function cancelRequest() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setReceiving(false);
  }

  function newChat() {
    voice.end();
    generation.current += 1;
    cancelRequest();
    restoreRequest.current?.abort();
    restoringRef.current = false;
    setRestoring(false);
    handles.current = { conversationId: null, visitorKey: null };
    try {
      localStorage.removeItem(CONV_KEY);
      localStorage.removeItem(KEY_KEY);
    } catch { /* Memory-only chat is available when storage is blocked. */ }
    setMessages([]);
    setError(null);
    setInput("");
    setTranscript("");
  }

  // Both input modes use one cancellable flight. The controller owns voice audio.
  async function send(question: string, fromVoice: boolean, signal?: AbortSignal, spokenLanguage?: string): Promise<{ text: string; language?: string }> {
    const text = question.trim();
    if (signal?.aborted || !mounted.current) throw aborted();
    if (!text || text.length > 4000) throw new ChatRequestError("invalid");
    if (request.current || restoringRef.current) throw new ChatRequestError("busy");
    const controller = new AbortController();
    request.current = controller;
    const ticket = generation.current;
    const current = () => mounted.current && generation.current === ticket;
    const cancel = () => {
      controller.abort();
      if (request.current === controller) {
        request.current = null;
        if (current()) setBusy(false);
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    setBusy(true);
    setError(null);
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: text }]);
    if (!fromVoice) setInput("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          ...(handles.current.conversationId ? { conversationId: handles.current.conversationId } : {}),
          ...(handles.current.visitorKey ? { visitorKey: handles.current.visitorKey } : {}),
          language: spokenLanguage && LANGUAGE_CODES.has(spokenLanguage) ? spokenLanguage : language,
          voice: fromVoice,
        }),
      }).catch((err: unknown) => {
        if (controller.signal.aborted || signal?.aborted || isRequestAbort(err)) throw aborted();
        throw new ChatRequestError("connection");
      });
      const payload: unknown = await res.json().catch(() => ({}));
      const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      if (!current()) throw aborted();
      // Keep handles even for HTTP errors, but never overwrite a newer chat/flight.
      if (request.current === controller && typeof data.conversationId === "string" && typeof data.visitorKey === "string") {
        handles.current = { conversationId: data.conversationId, visitorKey: data.visitorKey };
        try {
          localStorage.setItem(CONV_KEY, data.conversationId);
          localStorage.setItem(KEY_KEY, data.visitorKey);
        } catch { /* Retain handles in memory if browser storage is unavailable. */ }
      }
      if (controller.signal.aborted || signal?.aborted || request.current !== controller) throw aborted();
      if (!res.ok) throw httpRequestError(res.status);
      if (typeof data.answer !== "string" || !data.answer.trim()) throw new ChatRequestError("empty");
      setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: data.answer as string }]);
      return { text: data.answer as string, language: typeof data.language === "string" ? data.language : undefined };
    } catch (err) {
      if (current() && !controller.signal.aborted && !signal?.aborted && !isRequestAbort(err) && request.current === controller) setError(requestErrorMessage(err));
      throw err;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (request.current === controller) {
        request.current = null;
        if (current()) setBusy(false);
      }
    }
  }

  async function sendTyped(question: string) {
    const text = question.trim();
    if (voiceRunning || request.current || restoringRef.current || !text) return;
    if (text.length > 4000 || !mounted.current) {
      setError(requestErrorMessage(new ChatRequestError("invalid")));
      return;
    }

    const controller = new AbortController();
    request.current = controller;
    const ticket = generation.current;
    const current = () => mounted.current && generation.current === ticket;
    const assistantId = nextId();
    let assistantText = "";
    let donePayload: StreamPayload | null = null;
    let doneSeen = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    setBusy(true);
    setReceiving(false);
    setError(null);
    setMessages((prev) => [...prev,
      { id: nextId(), role: "user", content: text },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setInput("");

    const updateAssistant = (content: string) => {
      if (!current() || request.current !== controller) return;
      assistantText = content;
      setMessages((prev) => prev.map((message) => message.id === assistantId ? { ...message, content } : message));
    };
    const removeAssistant = () => {
      if (!current()) return;
      setMessages((prev) => prev.filter((message) => message.id !== assistantId));
    };
    const saveHandles = (payload: StreamPayload) => {
      if (request.current !== controller) return;
      if (typeof payload.conversationId !== "string" || typeof payload.visitorKey !== "string") return;
      handles.current = { conversationId: payload.conversationId, visitorKey: payload.visitorKey };
      try {
        localStorage.setItem(CONV_KEY, payload.conversationId);
        localStorage.setItem(KEY_KEY, payload.visitorKey);
      } catch { /* Retain handles in memory if browser storage is unavailable. */ }
    };
    const consumeEvent = (event: string, data: string) => {
      let parsed: unknown = data;
      try { parsed = JSON.parse(data); } catch { /* Token payloads may be plain text. */ }
      const payload = streamPayload(parsed);
      const kind = streamEventKind(event, payload);
      if (parsed === "[DONE]" || data === "[DONE]") {
        doneSeen = true;
        return;
      }
      if (kind === "error") throw streamError(payload);
      if (kind === "done" || kind === "complete") {
        doneSeen = true;
        donePayload = payload;
        saveHandles(payload);
        if (typeof payload.answer === "string") updateAssistant(payload.answer);
        return;
      }
      const token = streamToken(event, payload, typeof parsed === "string" ? parsed : data);
      if (token) {
        setReceiving(true);
        updateAssistant(assistantText + token);
      }
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          ...(handles.current.conversationId ? { conversationId: handles.current.conversationId } : {}),
          ...(handles.current.visitorKey ? { visitorKey: handles.current.visitorKey } : {}),
          language,
          voice: false,
        }),
      }).catch((err: unknown) => {
        if (controller.signal.aborted || isRequestAbort(err)) throw aborted();
        throw new ChatRequestError("connection");
      });
      if (!current() || controller.signal.aborted) throw aborted();

      if (!res.ok) {
        const payload = streamPayload(await res.json().catch(() => ({})));
        saveHandles(payload);
        throw httpRequestError(res.status);
      }

      const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
      reader = contentType.includes("text/event-stream") || (!contentType && !!res.body)
        ? res.body?.getReader?.() ?? null
        : null;
      if (!reader) {
        const payload = streamPayload(await res.json().catch(() => ({})));
        saveHandles(payload);
        if (typeof payload.answer !== "string" || !payload.answer.trim()) throw new ChatRequestError("empty");
        updateAssistant(payload.answer);
        doneSeen = true;
        donePayload = payload;
      } else {
        const decoder = new TextDecoder();
        let buffer = "";
        let event = "";
        let dataLines: string[] = [];
        const dispatch = () => {
          if (!dataLines.length) {
            event = "";
            return;
          }
          consumeEvent(event, dataLines.join("\n"));
          event = "";
          dataLines = [];
        };
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) {
              dispatch();
            } else if (line.startsWith("event:")) {
              event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
        }
        buffer += decoder.decode();
        if (buffer) {
          for (const line of buffer.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
        }
        dispatch();
        if (!doneSeen) throw new ChatRequestError("empty");
      }

      if (!current() || controller.signal.aborted || request.current !== controller) throw aborted();
      if (!assistantText.trim()) throw new ChatRequestError("empty");
      if (donePayload) saveHandles(donePayload);
    } catch (err) {
      if (reader) void reader.cancel().catch(() => { /* The request is already ending. */ });
      removeAssistant();
      if (current() && !controller.signal.aborted && !isRequestAbort(err) && request.current === controller) setError(requestErrorMessage(err));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (current()) {
          setBusy(false);
          setReceiving(false);
        }
      }
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    sendTyped(input);
  }

  const buttonStyle = "rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600";

  return (
    <main className="min-h-dvh bg-gradient-to-br from-sky-50 via-white to-violet-50 p-3 sm:flex sm:items-center sm:justify-center sm:p-4">
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl sm:h-[min(1000px,96dvh)] sm:min-h-[680px]">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <h1 className="text-base font-semibold text-slate-900">ShopEasy Voice Assistant</h1>
            <p className="text-xs text-slate-600">Multilingual help with orders, delivery, refunds & returns.</p>
          </div>
          <button type="button" onClick={newChat} className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">New chat</button>
        </header>

        <section aria-label="Voice assistant" className="shrink-0 space-y-3 border-b border-slate-200 bg-gradient-to-br from-sky-50 to-violet-50 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-sky-800">Your voice, a conversation</p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700">Language
                <select value={language} onChange={(event) => {
                  voice.end();
                  cancelRequest();
                  setTranscript("");
                  setLanguage(event.target.value);
                }} className="max-w-44 rounded-lg border border-slate-300 bg-white p-2 text-slate-900">
                  {LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700">Voice engine
                <select value={engine} disabled={voice.active} onChange={(event) => {
                  voice.end();
                  cancelRequest();
                  setTranscript("");
                  engineTouched.current = true;
                  setEngine(event.target.value as VoiceEngine);
                }} className="max-w-52 rounded-lg border border-slate-300 bg-white p-2 text-slate-900 disabled:opacity-50">
                  {serverVoice && <option value="server">Sarvam (server)</option>}
                  <option value="browser">Browser (on-device)</option>
                </select>
              </label>
            </div>
          </div>
          <div className="flex items-center gap-4 py-2">
            <div aria-hidden="true" className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full ring-8 ring-white/70 shadow-lg ${voice.phase === "listening" ? "motion-safe:animate-pulse bg-emerald-500" : voice.phase === "speaking" ? "motion-safe:animate-pulse bg-violet-500" : voice.phase === "thinking" ? "motion-safe:animate-pulse bg-amber-500" : "bg-sky-600"}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-8 w-8 text-white"><path strokeLinecap="round" d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" /></svg>
            </div>
            <div>
              <h2 role="status" aria-live="polite" className="text-lg font-semibold text-slate-900">{restoring ? "Restoring conversation…" : busy ? (receiving ? "Receiving reply…" : "Thinking about your question…") : PHASE_LABELS[voice.phase]}</h2>
              <p className="mt-1 text-sm text-slate-600">{voice.phase === "listening" ? "Ask your question. A natural pause sends it automatically." : voice.phase === "speaking" ? "Listen to the reply, or interrupt to take your turn." : voice.phase === "thinking" ? "Your microphone is paused while I prepare a reply." : voice.phase === "paused" ? "Type below or resume when you’re ready." : "Start once. Speak naturally. I’ll answer out loud."}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {voiceRunning ? <button type="button" onClick={voice.pause} className={`${buttonStyle} border border-sky-300 bg-white text-sky-900`}>Pause conversation</button> : <button type="button" disabled={busy || restoring || !!voice.support} onClick={() => {
              if (request.current || restoringRef.current) return;
              setError(null);
              setTranscript("");
              voice.start();
            }} className={`${buttonStyle} bg-sky-700 text-white hover:bg-sky-800`}>{voice.phase === "paused" ? "Resume conversation" : "Start conversation"}</button>}
            {(voice.active || voice.phase !== "idle") && <button type="button" onClick={voice.end} className={`${buttonStyle} border border-slate-300 bg-white text-slate-700`}>End conversation</button>}
            {voice.phase === "speaking" && <button type="button" onClick={voice.interrupt} className={`${buttonStyle} bg-violet-700 text-white hover:bg-violet-800`}>Interrupt / I want to speak</button>}
          </div>
          <div className="rounded-xl border border-white bg-white/80 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Live transcript</p>
            <p aria-live="polite" aria-atomic="true" className="mt-1 max-h-24 min-h-5 overflow-y-auto whitespace-pre-wrap break-words text-sm text-slate-800">{transcript || (voice.phase === "listening" ? "Listening for your words…" : "Your spoken words will appear here.")}</p>
          </div>
          <p className="text-xs leading-relaxed text-slate-600">While the session is active, the microphone restarts automatically after each reply. It pauses during answers to avoid echo. Switching away from this page pauses the session.</p>
          <p className="text-xs leading-relaxed text-slate-600">{engine === "server" ? "Server voice: your recorded audio is sent to our server and transcribed by Sarvam; replies are spoken by Sarvam. Audio is not stored. This mode handles code-mixed speech best but needs a network round-trip per turn." : "Browser voice: your browser recognizes speech and speaks replies, so audio may leave your device via your browser vendor. Our server only receives the final transcript."}</p>
          {voice.support && <p role="status" className="text-xs font-medium text-amber-800">{voice.support} You can still type below.</p>}
          {voice.error && <p role="alert" className="text-xs font-medium text-red-700">{voice.error}</p>}
          <details className="text-xs text-slate-600">
            <summary className="cursor-pointer font-medium">Voice privacy & availability</summary>
            <p className="mt-1">{engine === "server" ? "Your microphone audio is sent to our server and forwarded to Sarvam for transcription, and the reply text is sent to Sarvam for speech. Audio is processed per turn and not stored. Microphone access requires HTTPS or localhost and your permission." : "Your browser or its vendor may process microphone audio and spoken replies remotely. This app sends your transcript to the chat backend. Microphone access requires HTTPS or localhost and your permission."} Language and voice availability depend on your browser and device.</p>
          </details>
          <p className="text-xs font-medium text-slate-600">Support guidance only — no live order actions.</p>
        </section>

        <div aria-label="Chat messages" role="log" aria-live="polite" className="min-h-48 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && !busy && !restoring && <div className="space-y-3 py-3 text-center">
            <p className="text-sm text-slate-600">Start a voice conversation above, or type a question below.</p>
            <div className="flex flex-wrap justify-center gap-2">{SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" onClick={() => sendTyped(suggestion)} disabled={voiceRunning || busy || restoring} className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 hover:bg-sky-100 disabled:opacity-40">{suggestion}</button>)}</div>
          </div>}
          {messages.map((message) => <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[90%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-sm ${message.role === "user" ? "rounded-br-md bg-sky-700 text-white" : "rounded-bl-md bg-slate-100 text-slate-800"}`}><span className="sr-only">{message.role === "user" ? "You: " : "Assistant: "}</span>{message.content}</div>
          </div>)}
          {busy && <p role="status" className="text-sm text-slate-500">{receiving ? "Receiving reply…" : "Thinking…"}</p>}
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
          <div ref={scrollRef} />
        </div>

        <div className="shrink-0 space-y-2 border-t border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="typed-question" className="text-xs font-semibold text-slate-700">Prefer to type?</label>
            {voiceRunning && <button type="button" onClick={voice.pause} className="rounded-lg border border-sky-300 px-3 py-1.5 text-xs font-semibold text-sky-800">Pause to type</button>}
          </div>
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <textarea id="typed-question" aria-describedby="draft-help" rows={2} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                sendTyped(input);
              }
            }} placeholder={voiceRunning ? "Pause the conversation to type…" : "Type your question…"} readOnly={voiceRunning} disabled={restoring} maxLength={4000} className="min-w-0 flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-500 focus:border-sky-500 focus:ring-2 focus:ring-sky-200 read-only:bg-slate-50 disabled:opacity-50" />
            <button type="submit" disabled={busy || restoring || voiceRunning || !input.trim()} className={`${buttonStyle} bg-sky-700 text-white hover:bg-sky-800`}>Send</button>
          </form>
          <p id="draft-help" className="flex justify-between gap-2 text-xs text-slate-500"><span>{voiceRunning ? "Pause or end voice to send text. Your typed draft is kept." : "Enter to send · Shift + Enter for a new line"}</span><span className="shrink-0">{input.length}/4,000</span></p>
        </div>
      </div>
    </main>
  );
}
