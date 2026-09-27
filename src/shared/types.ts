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
}

export interface SpeakResponse {
  success: boolean;
  error?: string;
}

export type OffscreenMessage =
  | { type: 'PING' }
  | { type: 'SPEAK'; payload: SpeakRequest }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'SET_RATE'; payload: number }
  | { type: 'SET_VOICE'; payload: string }
  | { type: 'GET_VOICES' };

export type WordProgressPayload = { wordIndex: number; sentenceIndex: number; wordText: string };
export type SentenceProgressPayload = { sentenceIndex: number; sentenceText: string };

export type OffscreenResponse =
  | { type: 'PONG' }
  | { type: 'VOICES_LIST'; payload: VoiceInfo[] }
  | { type: 'SPEAKING_STARTED'; payload: { sentenceIndex: number } }
  | { type: 'WORD_PROGRESS'; payload: WordProgressPayload }
  | { type: 'SENTENCE_START'; payload: SentenceProgressPayload }
  | { type: 'SPEAKING_ENDED' }
  | { type: 'ERROR'; payload: string };

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
