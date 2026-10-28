# ShopEasy multilingual support

Next.js 16 / React 19 customer-support chat with Supabase persistence and pgvector retrieval, OpenRouter embeddings and answers, and optional browser speech recognition and synthesis.

## Run locally

1. Install dependencies with `npm ci`.
2. Configure `.env.local` using `.env.example`. Keep credentials private. The backend needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, and `LLM_MODEL`. Default embeddings are `BAAI/bge-m3` with 1,024 dimensions.
3. Apply the SQL migrations in `supabase/migrations/` in order to your intended Supabase database. Review them first: migration `0006` deletes existing chunks/embeddings and requires re-ingestion. Do not blindly rerun migrations against an existing database.
4. Ingest your support documents: `npm run ingest -- samples`. This writes to Supabase and calls the embedding provider. `npm run ingest -- samples --dry-run` only extracts, cleans, and chunks; it does not verify embeddings or database connectivity.
5. Run `npm run dev` and open `http://localhost:3000`.

## Voice conversations

No additional speech API key or package is required for **browser** voice. **Server** voice needs `SARVAM_API_KEY` (server-only). Your existing model and database configuration is still required to answer questions.

The voice loop supports two engines, chosen in the **Voice engine** selector before starting (the server option is offered only when it is configured):

- **Sarvam (server)** — uses Saaras v4 `codemix` STT and Bulbul v4 Flash TTS at `/api/voice/transcribe` and `/api/voice/synthesize`. The browser records one utterance with `MediaRecorder`, detects the end of speech locally, and POSTs the audio; the reply text is spoken back as audio. Best for code-mixed Indian languages, at the cost of a network round-trip per turn. Audio is transient and never stored.
- **Browser (on-device)** — uses the browser's Web Speech APIs and sends only the resulting transcript.

Both engines submit the transcript through the existing `/api/chat` RAG route, keep `SARVAM_API_KEY` on the server, validate audio/text limits, and return sanitized provider errors. `GET /api/voice/capabilities` reports whether server voice is configured, so the client never offers or claims Sarvam unless it is available.

Sarvam documents synchronous STT for audio under 30 seconds and TTS REST requests up to 2,500 characters. The adapters use the documented endpoints and model defaults but do not claim streaming. Official references: [STT REST](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/rest-api) and [TTS REST](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/rest-api).

1. Choose a **Voice engine** and select English, Hindi, Tamil, Telugu, Kannada, or Malayalam. This selects both recognition and reply language.
2. Click **Start conversation** once and allow microphone access. Speak naturally; your words appear in the live transcript.
3. When your utterance ends (browser end-of-speech, or the server recorder's local silence detection), the assistant automatically submits it, prepares a reply, and speaks the answer aloud. No Send button or per-turn microphone click is needed.
4. After the spoken reply finishes, the microphone automatically listens for your next turn. Recent conversation context supports follow-up questions.
5. Use **Interrupt / I want to speak** during playback to cut the reply short and take your turn. Listening pauses during playback to avoid hearing the assistant's own voice; spoken barge-in is not supported.
6. **Pause conversation** / **Resume conversation** controls the hands-free loop. **End conversation** stops it. Use **Pause to type** for text chat; the typed draft is separate from the live transcript.

Starting a conversation opts into automatic microphone restarts for that active session only. The session never starts on page load. Switching to another tab, changing language, or starting a new chat stops the active loop. Returning to the tab does not resume it without your action. Three consecutive empty recognition turns or a stalled listening/request/playback operation pause the session instead of retrying indefinitely. Permission, network, and playback failures also pause it. Pausing or ending cancels client-side work, but a request already received by the server may still be stored or completed there.

Microphone access requires HTTPS or localhost. Browser-engine recognition support varies by browser; try a current Chrome version if unavailable. Installed/device speech voices vary by language; a matching voice is required to start a browser-engine conversation, otherwise choose another language, install a matching system voice, use the server engine, or use text chat. The server engine needs a browser with `MediaRecorder` and microphone permission, and only supports the six listed languages. Denied permissions, unsupported languages, and speech service errors leave text chat available.

**Privacy:** with the browser engine, browser speech services may send audio to their vendor, and synthesis voices may also be remote. With the server engine, microphone audio is sent to this app's server and forwarded to Sarvam for transcription, and reply text is sent to Sarvam for speech; audio is processed per turn and not stored by this app. In both cases the app sends the transcript to the chat backend, stores messages in Supabase, and sends question/context text to the existing OpenRouter services.

## Admin dashboard

The dashboard lives under `/admin` and is protected by Supabase Auth plus a `profiles.role = 'admin'` check (`lib/admin/dal.ts`). Unauthenticated or non-admin visitors are redirected to `/admin/login`. Pages, layouts, and server actions all re-verify the admin role; authorization is never left to the UI alone.

Sections:

- **Overview** — knowledge-base health (documents/chunks/conversations/messages/customers) and recent unanswered questions.
- **Knowledge base** — upload PDF/TXT/MD files (extracted, chunked, embedded via `lib/ingestion`), re-embed an existing document from its stored chunks, or delete it.
- **Conversations** — recent guest sessions and per-message transcripts with language, RAG usage, and sources.
- **Customers** — create and delete customer records (`customer_profiles`).

Bootstrap the first admin (sign-up is not exposed in the UI):

1. Supabase Dashboard → **Authentication → Users → Add user** (email + password).
2. In the SQL Editor, promote that user:
   ```sql
   update public.profiles set role = 'admin' where id = '<user-id>';
   ```
   The first admin must be set directly; afterwards `select public.promote_to_admin('<user-id>')` works from an existing admin session.

## Conversation behavior and latency

The server verifies the conversation visitor key before loading the latest eight messages, bounded to 6,000 characters. It uses that history for follow-ups; client-supplied history is ignored. A heuristic adds prior-user context to likely follow-up retrieval queries without a separate model call. Voice replies request shorter, plain-text responses in native script. No-hit responses are localized without a generation request.

The reply language follows the customer. Every message is detected (native script or Romanized Tanglish/Hinglish/…), and the assistant mirrors that language and script; when detection is unsure it falls back to the selected language. In voice mode the spoken reply is generated in the recognized language — using Sarvam's detected `language_code` as a hint — and synthesized in that same language for a clean read, so it never forces English when the customer spoke in another language. The on-device (browser) voice engine speaks in the selected language, since it needs a matching installed system voice.

Typed chat streams answer tokens over SSE as soon as the retrieval context and OpenRouter stream are ready. Voice still waits for the complete answer before TTS so speech is not cut into unsafe fragments. Query embeddings use a bounded process-local cache, obvious greetings skip retrieval, and server VAD uses an 800 ms silence tail. This is a **continuous, hands-free, half-duplex conversation**, not a full-duplex realtime call. Listening and speaking alternate automatically, with a short 350 ms echo cooldown before the microphone restarts. End-to-end latency depends on browser end-of-speech detection, network, Supabase, and the configured OpenRouter model. No measured latency guarantee is made.

`OPENROUTER_PROVIDER_SORT=throughput` routes model requests toward the faster available provider. `EMBEDDING_CACHE_TTL_MS` and `EMBEDDING_CACHE_MAX_ENTRIES` bound the in-process query-vector cache. These are performance hints, not guarantees; measure warm and cold latency on the deployed platform. Serverless minimum instances, keep-alive settings, and region placement are deployment-provider settings and are not safely portable in this repository; configure them at the hosting platform and co-locate the app with the database where supported.

The assistant provides knowledge-base guidance only. It cannot look up live orders, issue refunds, cancel orders, or actually hand off to an agent. Those require authenticated customer/order integrations.

## Verification

```sh
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
```

The automated tests use offline HTTP mocks for chat routes, pure helpers, and an injected voice-session controller with fake recognition, synthesis, requests, and timers. They cover automatic multi-turn loops, no microphone/playback overlap, interruption, stale callbacks, cancellation, bounded retries, watchdogs, validation, prompts, history bounds, and the server engine's MIME selection, amplitude detector, and transcript shaping. They do not prove real microphone access, speech quality, or live model/database operation.

Manual device checks before release:

- Start once and complete at least three spoken turns without touching the microphone or Send controls, in each target language.
- Confirm one message per completed turn and that interim transcripts never submit by themselves.
- Deny microphone permission and verify typing still works.
- Interrupt playback and verify that the microphone resumes without transcribing the assistant's own audio.
- Pause/end while listening, waiting for a reply, or playing audio; late callbacks must not speak or restart listening.
- Switch tabs, then return: the session must remain paused until explicitly resumed.
- Let three recognition turns finish empty; verify the session pauses rather than looping forever.
- Change languages or start a new chat while listening; old callbacks must not submit a message.
- Ask a follow-up (for example, ask about returns, then “How long does that take?”).
- Reload to restore the latest history; simulate a temporary network failure and ensure the conversation keys remain available.
- Check a device without a matching language voice and confirm text-only fallback.
- On the server engine, speak a code-mixed sentence and confirm the local silence detector ends the turn without cutting you off, and that playback never re-triggers recording.

## Production caveats

### Troubleshooting a failed chat/voice request

Run `npx tsx scripts/diagnose-chat.ts --connectivity-only` to check DNS for the configured Supabase host, OpenRouter, and a control host without writing chat data. `ENOTFOUND` for Supabase means its configured hostname cannot be resolved on this machine: compare `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` with the active project's Project URL in the Supabase dashboard, and check DNS/network availability. Restart Next.js after correcting environment values. Do not paste service-role keys into chat or logs.

For an opt-in live pipeline check, `npx tsx scripts/diagnose-chat.ts` creates one synthetic support conversation and may call the paid model/embedding APIs. It prints only operation labels, HTTP statuses, allowlisted error codes, and result booleans—not keys, handles, provider payloads, or customer content. Offline tests do not substitute for this live connectivity check.

The SQL profile-update policy previously let a user update their own row, including `role`. Migration `0007_protect_profile_role.sql` adds a `SECURITY INVOKER` trigger that blocks authenticated non-admins from changing `role` (service-role, migrations, and the admin-guarded `promote_to_admin()` still work). Apply it and verify before allowing public authenticated access. Public chat and the server voice routes also need deployment-appropriate rate limiting and abuse controls; the built-in limiters are process-local. Keep `RAG_DEBUG` disabled in production; the diagnostic route exposes retrieved passages when enabled.

Conversation handles are bearer credentials held in browser storage. Do not log or share visitor keys. Browser speech compatibility, real multilingual answer quality, and latency must be tested on the target customer devices before launch.
