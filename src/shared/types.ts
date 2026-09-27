// Shared TypeScript types for Larynx extension

export interface TTSSettings {
  voice: string; // voice URI
  rate: number; // 0.5 - 2.0
  pauseOnPunctuation: boolean;
  sentenceGap: number; // milliseconds pause between sentences (default 300)
}

export interface VoiceInfo {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  isNatural: boolean;
}

export interface SpeakRequest {
  text: string;
  settings: TTSSettings;
  selectionRect?: DOMRect;
  /**
   * Identifies this read. The offscreen document echoes it on every message it
   * emits, so the background worker can tell a live run's progress apart from
   * the teardown of the run it just replaced.
   */
  runId: number;
}

export interface SpeakResponse {
  success: boolean;
  error?: string;
}

export type SpeechStatus = { speaking: boolean; paused: boolean };

export type OffscreenMessage =
  | { type: 'PING' }
  | { type: 'SPEAK'; payload: SpeakRequest }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'SET_RATE'; payload: number }
  | { type: 'SET_VOICE'; payload: string }
  | { type: 'GET_VOICES' }
  | { type: 'GET_STATUS' };

export type WordProgressPayload = { wordIndex: number; sentenceIndex: number; wordText: string };
export type SentenceProgressPayload = { sentenceIndex: number; sentenceText: string };

/** Every message the offscreen document emits carries the run that produced it. */
export type RunStamped = { runId: number };

// `Omit` collapses a union into a single object type, which loses the per-variant
// payload shapes. Distributing over the union first keeps them intact.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An outbound speech event, before the offscreen document stamps it with a run. */
export type RunStampedMessage = DistributiveOmit<
  Extract<OffscreenResponse, RunStamped>,
  'runId'
>;

export type OffscreenResponse =
  | { type: 'PONG' }
  | { type: 'VOICES_LIST'; payload: VoiceInfo[] }
  | { type: 'STATUS'; payload: SpeechStatus }
  | ({ type: 'SPEAKING_STARTED'; payload: { sentenceIndex: number } } & RunStamped)
  | ({ type: 'WORD_PROGRESS'; payload: WordProgressPayload } & RunStamped)
  | ({ type: 'SENTENCE_START'; payload: SentenceProgressPayload } & RunStamped)
  | ({ type: 'SPEAKING_ENDED' } & RunStamped)
  | ({ type: 'ERROR'; payload: string } & RunStamped);

export type ContentMessage =
  | { type: 'SELECTION'; payload: { text: string; rect: DOMRect | null } }
  | { type: 'WORD_PROGRESS'; payload: WordProgressPayload }
  | { type: 'SPEAK_ENDED' }
  | { type: 'SPEAK_ERROR'; payload: { error: string } }
  | { type: 'SETTINGS_CHANGED'; payload: Partial<TTSSettings> };

export type StoredSettings = TTSSettings;

export const DEFAULT_SETTINGS: TTSSettings = {
  voice: '',
  rate: 1.0,
  pauseOnPunctuation: true,
  sentenceGap: 300,
};
