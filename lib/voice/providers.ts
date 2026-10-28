/**
 * Speech provider contracts shared by the voice adapters and routes.
 *
 * These interfaces contain configuration-neutral data only. API keys and
 * provider clients belong in the implementation that wires a provider at
 * runtime; they must not cross this boundary. Audio input is transient request
 * data and no contract has a persistence operation for it.
 */

export interface ProviderCapabilities {
  readonly available: boolean;
  readonly reason?: string;
}

export interface SpeechToTextRequest {
  readonly language: string;
  /** Transient bytes supplied by the caller; providers must not retain them. */
  readonly audio?: Readonly<Uint8Array>;
  readonly mimeType?: string;
  readonly signal?: AbortSignal;
}

export interface SpeechToTextResult {
  readonly text: string;
  readonly language?: string;
  readonly confidence?: number;
}

export interface SpeechToTextProvider {
  readonly capabilities: ProviderCapabilities;
  execute(request: SpeechToTextRequest): Promise<SpeechToTextResult>;
}

export interface TextToSpeechRequest {
  readonly text: string;
  readonly language: string;
  readonly signal?: AbortSignal;
}

export interface TextToSpeechResult {
  /** Provider audio bytes; callers decide whether and how to play them. */
  readonly audio: Readonly<Uint8Array>;
  readonly mimeType: string;
  readonly durationMs?: number;
}

export interface TextToSpeechProvider {
  readonly capabilities: ProviderCapabilities;
  execute(request: TextToSpeechRequest): Promise<TextToSpeechResult>;
}
