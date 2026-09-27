// Offscreen Document — Web Speech API TTS engine with word-level progress
//
// Owns `window.speechSynthesis` for the whole extension. Emits a global word index
// (not per-sentence) so the content script can highlight against its flat list of
// word spans without having to re-split the text itself.

import { splitIntoSentences, estimateDuration } from '../shared/text-utils';
import {
  OffscreenMessage,
  OffscreenResponse,
  SpeakRequest,
  SpeechStatus,
  VoiceInfo,
  TTSSettings,
} from '../shared/types';

const OFFSCREEN_MESSAGE_TYPES = new Set<OffscreenMessage['type']>([
  'PING',
  'SPEAK',
  'PAUSE',
  'RESUME',
  'STOP',
  'SET_RATE',
  'SET_VOICE',
  'GET_VOICES',
  'GET_STATUS',
]);

const WORD_TICK_MS = 30;
const MIN_WORD_INTERVAL_MS = 60;
const CLAUSE_GAP_MS = 180;
const RESTART_WAIT_MS = 2000;

interface WordTicker {
  sentenceIndex: number;
  words: string[];
  base: number;
  local: number;
  nextAt: number;
  intervalMs: number;
}

let currentUtterance: SpeechSynthesisUtterance | null = null;
let sentenceQueue: string[] = [];
let currentSentenceIndex = 0;
let wordOffset = 0;
let isProcessing = false;
let stopRequested = false;
let isPaused = false;
let wordTicker: ReturnType<typeof setInterval> | null = null;
let ticker: WordTicker | null = null;
let currentSettings: TTSSettings = {
  voice: '',
  rate: 1.0,
  pauseOnPunctuation: true,
  sentenceGap: 300,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(message: OffscreenResponse): void {
  // Promise form: swallows "no receiving end" instead of logging an unchecked lastError.
  chrome.runtime.sendMessage(message).catch(() => {});
}

function getVoices(): VoiceInfo[] {
  if (!window.speechSynthesis) return [];
  const voices = window.speechSynthesis.getVoices();
  const naturalKeywords = ['neural', 'enhanced', 'premium', 'google', 'microsoft', 'apple', 'wave'];
  return voices.map((v) => ({
    name: v.name,
    lang: v.lang,
    voiceURI: v.voiceURI,
    localService: v.localService,
    isNatural: naturalKeywords.some(
      (k) => v.name.toLowerCase().includes(k) || v.voiceURI.toLowerCase().includes(k),
    ),
  }));
}

function findVoice(voiceURI: string): SpeechSynthesisVoice | null {
  if (!window.speechSynthesis || !voiceURI) return null;
  return window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI) || null;
}

/** Playback state the background worker polls to drive the pause/resume toggle. */
function getStatus(): SpeechStatus {
  const synth = window.speechSynthesis;
  return {
    speaking: isProcessing || Boolean(synth && synth.speaking),
    paused: isPaused,
  };
}

/* ------------------------------------------------------------------ *
 * Word progress ticker
 *
 * Timing is tracked against absolute wall-clock deadlines, so pausing simply
 * freezes advancement and resuming picks up exactly where it left off.
 * ------------------------------------------------------------------ */

function stopWordTicker(): void {
  if (wordTicker) {
    clearInterval(wordTicker);
    wordTicker = null;
  }
  ticker = null;
}

function tickWords(): void {
  if (isPaused || !ticker) return;
  const now = Date.now();
  while (ticker.local < ticker.words.length && now >= ticker.nextAt) {
    const { sentenceIndex, words, base, local, intervalMs } = ticker;
    send({
      type: 'WORD_PROGRESS',
      payload: { wordIndex: base + local, sentenceIndex, wordText: words[local] },
    });
    ticker.local = local + 1;
    ticker.nextAt += intervalMs;
  }
}

function startWordTicker(
  sentenceIndex: number,
  words: string[],
  base: number,
  rate: number,
): void {
  const estimated = estimateDuration(words.join(' '), rate);
  const intervalMs = words.length > 0
    ? Math.max(MIN_WORD_INTERVAL_MS, estimated / words.length)
    : 150;

  ticker = {
    sentenceIndex,
    words,
    base,
    local: 0,
    nextAt: Date.now() + intervalMs,
    intervalMs,
  };

  if (!wordTicker) {
    wordTicker = setInterval(tickWords, WORD_TICK_MS);
  }
}

/** Re-arms the ticker after a pause without fast-forwarding through unread words. */
function resumeWordTicker(): void {
  if (!ticker) return;
  ticker.nextAt = Date.now() + ticker.intervalMs;
  if (!wordTicker) {
    wordTicker = setInterval(tickWords, WORD_TICK_MS);
  }
}

/* ------------------------------------------------------------------ *
 * Speech
 * ------------------------------------------------------------------ */

function splitClauses(text: string, pauseOnPunctuation: boolean): string[] {
  if (!pauseOnPunctuation) return [text];
  const clauses = text
    .split(/(?<=[,;:])\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
  return clauses.length > 0 ? clauses : [text];
}

/** Word texts plus each word's character offset, so a boundary charIndex can be mapped back. */
function tokenizeWithOffsets(text: string): { words: string[]; offsets: number[] } {
  const words: string[] = [];
  const offsets: number[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    offsets.push(match.index);
    words.push(match[0]);
  }
  return { words, offsets };
}

/** Binary-searches the word containing `charIndex`. */
function wordIndexAt(offsets: number[], charIndex: number): number {
  let low = 0;
  let high = offsets.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= charIndex) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function speakUtterance(
  text: string,
  settings: TTSSettings,
  sentenceIndex: number,
  base: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      reject(new Error('Speech Synthesis not available'));
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    currentUtterance = utterance;

    const voice = findVoice(settings.voice);
    if (voice) utterance.voice = voice;
    utterance.rate = settings.rate;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    const { words, offsets } = tokenizeWithOffsets(text);
    // Chrome fires `boundary` with a real charIndex; the ticker is only a
    // fallback for engines that never do.
    let sawBoundary = false;

    const emit = (local: number) => {
      if (local < 0 || local >= words.length) return;
      send({
        type: 'WORD_PROGRESS',
        payload: { wordIndex: base + local, sentenceIndex, wordText: words[local] },
      });
    };

    utterance.onstart = () => {
      send({ type: 'SPEAKING_STARTED', payload: { sentenceIndex } });
      startWordTicker(sentenceIndex, words, base, settings.rate);
    };

    utterance.onboundary = (event) => {
      const charIndex = (event as SpeechSynthesisEvent).charIndex;
      if (typeof charIndex !== 'number' || offsets.length === 0) return;
      // Ground truth arrived, so the estimate would only fight it.
      if (!sawBoundary) {
        sawBoundary = true;
        stopWordTicker();
      }
      emit(wordIndexAt(offsets, charIndex));
    };

    utterance.onend = () => {
      stopWordTicker();
      currentUtterance = null;
      // The final word gets no boundary event of its own.
      if (sawBoundary) emit(words.length - 1);
      resolve(words.length);
    };

    utterance.onerror = (event) => {
      stopWordTicker();
      currentUtterance = null;
      const reason = event.error || 'unknown';
      // cancel()/pause() churn is an expected control-flow path, not a failure.
      if (stopRequested || reason === 'canceled' || reason === 'interrupted') {
        resolve(words.length);
        return;
      }
      reject(new Error(reason));
    };

    window.speechSynthesis.speak(utterance);
  });
}

/** Speaks one sentence, clause by clause, honouring `pauseOnPunctuation`. */
async function speakSentence(
  text: string,
  settings: TTSSettings,
  sentenceIndex: number,
  base: number,
): Promise<number> {
  const clauses = splitClauses(text, settings.pauseOnPunctuation);
  let spoken = 0;

  for (let i = 0; i < clauses.length; i++) {
    spoken += await speakUtterance(clauses[i], settings, sentenceIndex, base + spoken);
    if (stopRequested) break;
    if (i < clauses.length - 1 && !isPaused) {
      await delay(CLAUSE_GAP_MS);
    }
  }

  return spoken;
}

async function startSpeak(request: SpeakRequest): Promise<void> {
  if (isProcessing) {
    stopRequested = true;
    window.speechSynthesis.cancel();
    const deadline = Date.now() + RESTART_WAIT_MS;
    while (isProcessing && Date.now() < deadline) {
      await delay(20);
    }
  }

  window.speechSynthesis.cancel();

  currentSettings = { ...currentSettings, ...request.settings };
  currentSentenceIndex = 0;
  wordOffset = 0;
  isPaused = false;
  stopRequested = false;
  sentenceQueue = splitIntoSentences(request.text);

  if (sentenceQueue.length === 0) {
    send({ type: 'ERROR', payload: 'No valid sentences' });
    send({ type: 'SPEAKING_ENDED' });
    return;
  }

  isProcessing = true;

  try {
    while (sentenceQueue.length > 0 && !stopRequested) {
      const sentence = sentenceQueue.shift()!;
      const sentenceIndex = currentSentenceIndex;

      send({
        type: 'SENTENCE_START',
        payload: { sentenceIndex, sentenceText: sentence },
      });

      const spoken = await speakSentence(
        sentence,
        currentSettings,
        sentenceIndex,
        wordOffset,
      );
      wordOffset += spoken;
      currentSentenceIndex++;

      if (stopRequested) break;
      if (currentSettings.sentenceGap > 0 && sentenceQueue.length > 0) {
        await delay(currentSettings.sentenceGap);
      }
    }
  } catch (error) {
    console.error('[Larynx Offscreen] Speech error:', error);
    send({ type: 'ERROR', payload: (error as Error).message });
  } finally {
    isProcessing = false;
    stopWordTicker();
    send({ type: 'SPEAKING_ENDED' });
  }
}

function stopSpeech(): void {
  stopRequested = true;
  window.speechSynthesis.cancel();
  stopWordTicker();
  sentenceQueue = [];
  isPaused = false;
  currentUtterance = null;
}

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  // Ignore traffic meant for the background worker or the content script.
  if (!message || !OFFSCREEN_MESSAGE_TYPES.has(message.type)) return false;

  (async () => {
    try {
      switch (message.type) {
        case 'PING': {
          sendResponse({ type: 'PONG' });
          break;
        }

        case 'SPEAK': {
          sendResponse({ success: true });
          void startSpeak(message.payload);
          break;
        }

        case 'PAUSE': {
          if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
            isPaused = true;
          }
          sendResponse({ success: true });
          break;
        }

        case 'RESUME': {
          if (isPaused) {
            window.speechSynthesis.resume();
            isPaused = false;
            resumeWordTicker();
          }
          sendResponse({ success: true });
          break;
        }

        case 'STOP': {
          stopSpeech();
          sendResponse({ success: true });
          break;
        }

        case 'SET_RATE': {
          currentSettings.rate = message.payload;
          if (currentUtterance) currentUtterance.rate = message.payload;
          sendResponse({ success: true });
          break;
        }

        case 'SET_VOICE': {
          currentSettings.voice = message.payload;
          if (currentUtterance) {
            const voice = findVoice(message.payload);
            if (voice) currentUtterance.voice = voice;
          }
          sendResponse({ success: true });
          break;
        }

        case 'GET_STATUS': {
          sendResponse({ type: 'STATUS', payload: getStatus() });
          break;
        }

        case 'GET_VOICES': {
          let voices = getVoices();
          if (voices.length === 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1000);
              const handler = () => {
                clearTimeout(timer);
                window.speechSynthesis.removeEventListener('voiceschanged', handler);
                resolve();
              };
              window.speechSynthesis.addEventListener('voiceschanged', handler);
            });
            voices = getVoices();
          }
          sendResponse({ type: 'VOICES_LIST', payload: voices });
          break;
        }
      }
    } catch (error) {
      send({ type: 'ERROR', payload: (error as Error).message });
      sendResponse({ success: false, error: (error as Error).message });
    }
  })();

  return true;
});

console.log('[Larynx Offscreen] Loaded');
