// Offscreen Document — Web Speech API TTS engine with word-level progress
//
// Owns `window.speechSynthesis` for the whole extension. Emits a global word index
// (not per-sentence) so the content script can highlight against its flat list of
// word spans without having to re-split the text itself.

import { splitIntoSentences, estimateDuration } from '../shared/text-utils';
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
const CATCHUP_STEP_MS = 20;
const CLAUSE_GAP_MS = 180;
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
  sentenceGap: 300,
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

    /* -------------------------------------------------------------- *
     * Word sequencer
     *
     * A single monotonic cursor (`emitted`) owns word progress. `boundary`
     * events never move the cursor directly — they only push the clock
     * forwards or backwards. That is what makes skipping impossible:
     * every word is emitted exactly once, in order, no matter how late,
     * sparse or bursty the engine's boundary events turn out to be.
     *
     * `charsPerMs` is learned from the gaps between consecutive boundary
     * events, so the interval used between sparse events converges on the
     * real speaking rate instead of a fixed guess.
     * -------------------------------------------------------------- */
    let emitted = -1;
    let nextAt = 0;
    let stepMs = 0;
    let charsPerMs = 0;
    let hint = 0;
    let lastBoundaryAt = 0;
    let lastBoundaryIndex = 0;
    let handle: ReturnType<typeof setInterval> | null = null;

    const emit = (local: number) => {
      if (local < 0 || local >= words.length) return;
      sendRunStamped({
        type: 'WORD_PROGRESS',
        payload: { wordIndex: base + local, sentenceIndex, wordText: words[local] },
      });
    };

    /** Milliseconds to hold the cursor at word `i`. */
    const paceFor = (i: number): number => {
      const word = words[i] || '';
      if (charsPerMs > 0) {
        return Math.max(MIN_WORD_INTERVAL_MS, (word.length + 1) / charsPerMs);
      }
      return Math.max(
        MIN_WORD_INTERVAL_MS,
        estimateDuration(`${word} `, settings.rate) * 1000,
      );
    };

    const stop = () => {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      activePump = null;
    };

    const pump = () => {
      if (isPaused) return;
      if (emitted >= words.length - 1) {
        stop();
        return;
      }
      const now = Date.now();
      if (now < nextAt) return;

      emitted++;
      emit(emitted);

      // Far behind the engine's own signal: sprint forward, but still one word
      // per step, so nothing is skipped and nothing is highlighted twice.
      const behind = hint - 1 - emitted;
      stepMs = behind > 2 ? CATCHUP_STEP_MS : paceFor(emitted);
      nextAt = now + stepMs;
    };

    utterance.onstart = () => {
      sendRunStamped({ type: 'SPEAKING_STARTED', payload: { sentenceIndex } });
      emitted = -1;
      stepMs = paceFor(0);
      nextAt = Date.now() + stepMs;
      hint = 1;
      handle = setInterval(pump, PUMP_TICK_MS);
      activePump = {
        rearm: () => {
          nextAt = Date.now() + RESUME_DELAY_MS;
        },
      };
    };

    utterance.onboundary = (event) => {
      const charIndex = (event as SpeechSynthesisEvent).charIndex;
      if (typeof charIndex !== 'number' || offsets.length === 0) return;

      const i = wordIndexAt(offsets, charIndex);
      const now = Date.now();

      // Learn the real speaking rate from the gap since the previous boundary.
      // Pauses are self-correcting here: the frozen interval simply produces a
      // low average, and the next few boundaries pull it back up.
      const deltaChars = charIndex - lastBoundaryIndex;
      const deltaMs = now - lastBoundaryAt;
      if (lastBoundaryAt > 0 && deltaChars > 0 && deltaMs > 20) {
        charsPerMs = deltaChars / deltaMs;
      }
      lastBoundaryAt = now;
      lastBoundaryIndex = charIndex;

      if (i > hint - 1) hint = i + 1;

      if (handle === null) return;

      if (emitted >= i) {
        // We over-ran the engine: give the surplus words their time back.
        nextAt = now + (emitted - i + 1) * paceFor(i);
      } else {
        // We are behind: the next word goes out as soon as the engine reaches it.
        nextAt = now;
        stepMs = paceFor(emitted + 1);
      }
    };

    /** Emits any word the engine never reached, so the tail is never left dark. */
    const flush = () => {
      while (emitted < words.length - 1) {
        emitted++;
        emit(emitted);
      }
    };

    utterance.onend = () => {
      stop();
      currentUtterance = null;
      flush();
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
