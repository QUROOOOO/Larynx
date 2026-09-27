// Shared TypeScript types for Larynx extension

export interface TTSSettings {
  voice: string; // voice URI
  rate: number; // 0.5 - 2.0
  pauseOnPunctuation: boolean;
}

export interface VoiceInfo {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  isNatural: boolean; // heuristic: Neural/Enhanced/Premium/Google/Microsoft/Apple
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
  | { type: 'SPEAK'; payload: SpeakRequest }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'SET_RATE'; payload: number }
  | { type: 'SET_VOICE'; payload: string }
  | { type: 'GET_VOICES' };

export type OffscreenResponse =
  | { type: 'VOICES_LIST'; payload: VoiceInfo[] }
  | { type: 'SPEAKING_STARTED' }
  | { type: 'SENTENCE_START'; payload: { index: number; text: string } }
  | { type: 'SPEAKING_ENDED' }
  | { type: 'ERROR'; payload: string };

export type SentenceProgressPayload = {
  sentenceIndex: number;
  sentenceText: string;
};

export type ContentMessage =
  | { type: 'SELECTION'; payload: { text: string; rect: DOMRect } }
  | { type: 'PILL_ACTION'; payload: PillAction }
  | { type: 'SETTINGS_CHANGED'; payload: Partial<TTSSettings> }
  | { type: 'SENTENCE_PROGRESS'; payload: SentenceProgressPayload }
  | { type: 'PILL_STATE'; payload: { isPlaying?: boolean; rate?: number } }
  | { type: 'HIDE_PILL' };

export type PillAction =
  | { action: 'play_pause' }
  | { action: 'speed_up' }
  | { action: 'speed_down' }
  | { action: 'next_voice' }
  | { action: 'dismiss' };

export type BackgroundMessage =
  | { type: 'INJECT_CONTENT_SCRIPT'; payload: { tabId: number } }
  | { type: 'GET_SETTINGS' }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<TTSSettings> };

export interface StoredSettings extends TTSSettings {
  shortcut?: string;
}

export const DEFAULT_SETTINGS: TTSSettings = {
  voice: '',
  rate: 1.0,
  pauseOnPunctuation: true,
};
