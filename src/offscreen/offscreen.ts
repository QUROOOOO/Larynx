// Offscreen Document — Web Speech API TTS engine with word-level progress
// v1.3.0
//
// Owns `window.speechSynthesis` for the whole extension. Emits a global word index
// (not per-sentence) so the content script can highlight against its flat list of
// word spans without having to re-split the text itself.

import { splitIntoSentences } from '../shared/text-utils';
import {
  OffscreenMessage,
  OffscreenResponse,
  RunStampedMessage,
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

const PUMP_TICK_MS = 16;
const MIN_WORD_INTERVAL_MS = 55;
const RESTART_WAIT_MS = 2000;
const RESUME_DELAY_MS = 120;

let currentUtterance: SpeechSynthesisUtterance | null = null;
let sentenceQueue: string[] = [];
let currentSentenceIndex = 0;
let wordOffset = 0;
let isProcessing = false;
let stopRequested = false;
let isPaused = false;

/**
 * The pump belonging to the utterance that is currently speaking. Only used to
 * re-base its clock after a pause; advancing the cursor lives in `speakUtterance`.
 */
let activePump: { rearm: () => void } | null = null;

function clearActivePump(): void {
  activePump = null;
}

/**
 * The run whose messages are currently being emitted.
 *
 * A new read never begins instantly: `startSpeak` first waits for the previous
 * run to unwind, and that run reports `SPEAKING_ENDED` on its way out. Because
 * `activeRunId` is only advanced *after* that wait, the outgoing teardown still
 * carries the old run's stamp, and the background worker can recognise it as
 * superseded instead of applying it to the new read's page.
 */
let activeRunId = 0;
let currentSettings: TTSSettings = {
  voice: '',
  rate: 1.0,
  pauseOnPunctuation: true,
  sentenceGap: 120,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(message: OffscreenResponse): void {
  // Promise form: swallows "no receiving end" instead of logging an unchecked lastError.
  chrome.runtime.sendMessage(message).catch(() => {});
}

/**
 * Emits a message attributed to `activeRunId`. Every speech event goes through
 * here so the background worker can drop anything belonging to a superseded run.
 */
function sendRunStamped(message: RunStampedMessage): void {
  send({ ...message, runId: activeRunId });
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
  if (!window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  if (voiceURI) {
    const exact = voices.find((v) => v.voiceURI === voiceURI);
    if (exact) return exact;
  }
  // Auto-select best natural voice if not specified or not found
  const naturalKeywords = ['online (natural)', 'natural', 'neural', 'google us english', 'enhanced', 'premium'];
  for (const kw of naturalKeywords) {
    const match = voices.find((v) => v.lang.startsWith('en') && v.name.toLowerCase().includes(kw));
    if (match) return match;
  }
  const english = voices.find((v) => v.lang.startsWith('en') && !v.name.toLowerCase().includes('desktop'));
  if (english) return english;
  return voices[0] || null;
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
 * Speech
 * ------------------------------------------------------------------ */

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

    // Human prosodic intonation shaping:
    // Natural human readers modulate pitch and energy based on sentence punctuation
    const trimmed = text.trim();
    if (trimmed.endsWith('?')) {
      utterance.pitch = 1.06; // Question rising inflection
    } else if (trimmed.endsWith('!')) {
      utterance.pitch = 1.03; // Emphatic declarative
    } else if (/^\([^)]+\)$/.test(trimmed)) {
      utterance.pitch = 0.95; // Soft parenthetical aside
      utterance.rate = settings.rate * 0.96;
    } else {
      utterance.pitch = 1.0;
    }
    utterance.volume = 1.0;

    const { words, offsets } = tokenizeWithOffsets(text);

    let hasBoundarySupport = false;
    let emitted = -1;
    let nextAt = 0;
    let handle: ReturnType<typeof setInterval> | null = null;
    // Track time between boundary events to calibrate fallback pacing
    let lastBoundaryTime = 0;
    let lastBoundaryWordIdx = -1;
    let measuredMsPerWord = 0; // 0 = not yet calibrated

    const emit = (local: number) => {
      if (local < 0 || local >= words.length) return;
      sendRunStamped({
        type: 'WORD_PROGRESS',
        payload: { wordIndex: base + local, sentenceIndex, wordText: words[local] },
      });
    };

    /** Milliseconds to hold the cursor at word `i` when using fallback pacing. */
    const paceFor = (i: number): number => {
      const word = words[i] || '';
      // Use measured real voice speed if we have calibration data, else use 145 WPM estimate
      // Real TTS voices typically run 120-180 WPM depending on voice and rate setting
      const baseMsPerWord = measuredMsPerWord > 0
        ? measuredMsPerWord
        : (380 / Math.max(0.2, settings.rate));
      const cleanLen = word.replace(/[^\p{L}\p{N}]/gu, '').length;

      // Syllable-length factor relative to average English word (~5 chars)
      let factor = 1.0;
      if (cleanLen <= 2) factor = 0.60;
      else if (cleanLen <= 4) factor = 0.82;
      else if (cleanLen <= 6) factor = 1.00;
      else if (cleanLen <= 9) factor = 1.20;
      else factor = 1.45;

      let punctuationPause = 0;
      if (settings.pauseOnPunctuation) {
        if (/[,;—–]/.test(word)) {
          punctuationPause = Math.round(120 / settings.rate);
        } else if (/[.!?:]/.test(word)) {
          punctuationPause = Math.round(220 / settings.rate);
        }
      }

      return Math.max(MIN_WORD_INTERVAL_MS, Math.round(baseMsPerWord * factor) + punctuationPause);
    };

    const stop = () => {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      activePump = null;
    };

    const pump = () => {
      if (isPaused || stopRequested) return;

      // If the engine is firing real boundary events, it owns the cursor.
      // The pump only runs as a fallback for voices that don't fire boundaries.
      if (hasBoundarySupport) return;

      if (emitted >= words.length - 1) {
        stop();
        return;
      }
      const now = Date.now();
      if (now < nextAt) return;

      emitted++;
      emit(emitted);
      nextAt = now + paceFor(emitted);
    };

    utterance.onstart = () => {
      sendRunStamped({ type: 'SPEAKING_STARTED', payload: { sentenceIndex } });
      // Don't emit word 0 immediately — wait for onboundary or hold for startup latency
      // This prevents the highlight from jumping ahead before audio begins
      emitted = -1;
      hasBoundarySupport = false;
      lastBoundaryTime = 0;
      lastBoundaryWordIdx = -1;
      measuredMsPerWord = 0;

      // Audio startup latency before first word is heard: ~150ms for local voices,
      // ~300ms+ for network/neural voices. Start at word 0 after startup buffer.
      nextAt = Date.now() + 160;
      handle = setInterval(pump, PUMP_TICK_MS);
      activePump = {
        rearm: () => {
          // After resume, hold current position briefly before stepping
          nextAt = Date.now() + RESUME_DELAY_MS;
        },
      };
    };

    utterance.onboundary = (event) => {
      const boundaryEvent = event as SpeechSynthesisEvent;
      // Filter out sentence boundaries (Chrome fires 'sentence' with charIndex: 0)
      if (boundaryEvent.name && boundaryEvent.name !== 'word') return;

      const charIndex = boundaryEvent.charIndex;
      if (typeof charIndex !== 'number' || offsets.length === 0) return;

      const i = wordIndexAt(offsets, charIndex);
      if (i < 0 || i >= words.length) return;

      const now = Date.now();

      // Real boundary support confirmed — disable fallback pump
      if (!hasBoundarySupport) {
        hasBoundarySupport = true;
      }

      // Calibrate measured pace from real boundary deltas
      if (lastBoundaryTime > 0 && lastBoundaryWordIdx >= 0 && i > lastBoundaryWordIdx) {
        const wordSpan = i - lastBoundaryWordIdx;
        const timeSpan = now - lastBoundaryTime;
        if (timeSpan > 30 && timeSpan < 2000) {
          const measured = timeSpan / wordSpan;
          // Smooth exponential moving average
          measuredMsPerWord = measuredMsPerWord > 0
            ? measuredMsPerWord * 0.6 + measured * 0.4
            : measured;
        }
      }
      lastBoundaryTime = now;
      lastBoundaryWordIdx = i;

      // Strictly advance monotonically: never go backwards
      if (i > emitted) {
        // Emit each word sequentially — never skip/jump multiple words at once.
        // This keeps the highlight from teleporting when boundary events are sparse.
        const wordsBetween = i - Math.max(0, emitted + 1);
        if (wordsBetween > 1 && measuredMsPerWord > 0) {
          // Spread missed words over time using measured pace
          const delayPerWord = Math.max(20, measuredMsPerWord * 0.85);
          for (let w = Math.max(0, emitted + 1); w < i; w++) {
            const delay = (w - Math.max(0, emitted + 1)) * delayPerWord;
            const capturedW = w;
            setTimeout(() => {
              if (!stopRequested && !isPaused) emit(capturedW);
            }, delay);
          }
        } else if (emitted < 0) {
          // First boundary: emit word 0 immediately
          emit(0);
        }
        emitted = i;
        emit(emitted);
      }
    };

    utterance.onend = () => {
      stop();
      currentUtterance = null;
      if (emitted < words.length - 1) {
        emitted = words.length - 1;
        emit(emitted);
      }
      resolve(words.length);
    };

    utterance.onerror = (event) => {
      stop();
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

  // Only now is the previous run fully unwound, so it is safe to take ownership
  // of the run stamp: anything the old run still emits was sent before this
  // point and keeps the old stamp.
  activeRunId = request.runId;

  currentSettings = { ...currentSettings, ...request.settings };
  currentSentenceIndex = 0;
  wordOffset = 0;
  isPaused = false;
  stopRequested = false;
  sentenceQueue = splitIntoSentences(request.text);

  if (sentenceQueue.length === 0) {
    sendRunStamped({ type: 'ERROR', payload: 'No valid sentences' });
    sendRunStamped({ type: 'SPEAKING_ENDED' });
    return;
  }

  isProcessing = true;

  try {
    while (sentenceQueue.length > 0 && !stopRequested) {
      const sentence = sentenceQueue.shift()!;
      const sentenceIndex = currentSentenceIndex;

      sendRunStamped({
        type: 'SENTENCE_START',
        payload: { sentenceIndex, sentenceText: sentence },
      });

      // One utterance per sentence. The engine owns every pause inside the
      // sentence, so a single request per sentence keeps one continuous
      // intonation contour and avoids the dead air that a fresh `speak()` call
      // costs while the voice re-primes between utterances.
      const spoken = await speakUtterance(
        sentence,
        currentSettings,
        sentenceIndex,
        wordOffset,
      );
      wordOffset += spoken;
      currentSentenceIndex++;

      if (stopRequested) break;
      if (
        currentSettings.pauseOnPunctuation &&
        currentSettings.sentenceGap > 0 &&
        sentenceQueue.length > 0
      ) {
        await delay(currentSettings.sentenceGap);
      }
    }
  } catch (error) {
    console.error('[Larynx Offscreen] Speech error:', error);
    sendRunStamped({ type: 'ERROR', payload: (error as Error).message });
  } finally {
    isProcessing = false;
    clearActivePump();
    sendRunStamped({ type: 'SPEAKING_ENDED' });
  }
}

function stopSpeech(): void {
  stopRequested = true;
  window.speechSynthesis.cancel();
  clearActivePump();
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
            activePump?.rearm();
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
      sendRunStamped({ type: 'ERROR', payload: (error as Error).message });
      sendResponse({ success: false, error: (error as Error).message });
    }
  })();

  return true;
});

console.log('[Larynx Offscreen] Loaded');
