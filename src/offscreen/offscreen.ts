// Offscreen Document — Web Speech API TTS Engine
// Runs in offscreen document context, handles speech synthesis

import { splitIntoSentences } from '../shared/text-utils';
import { 
  OffscreenMessage, 
  OffscreenResponse, 
  VoiceInfo, 
  TTSSettings
} from '../shared/types';

let currentUtterance: SpeechSynthesisUtterance | null = null;
let sentenceQueue: string[] = [];
let currentSentenceIndex = 0;
let currentSettings: TTSSettings = { voice: '', rate: 1.0, pauseOnPunctuation: true };
let isPaused = false;

function getVoices(): VoiceInfo[] {
  if (!window.speechSynthesis) return [];
  
  const voices = window.speechSynthesis.getVoices();
  const naturalKeywords = ['neural', 'enhanced', 'premium', 'google', 'microsoft', 'apple', 'wave'];
  
  return voices.map(v => ({
    name: v.name,
    lang: v.lang,
    voiceURI: v.voiceURI,
    localService: v.localService,
    isNatural: naturalKeywords.some(k => v.name.toLowerCase().includes(k) || v.voiceURI.toLowerCase().includes(k)),
  }));
}

function findVoice(voiceURI: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.voiceURI === voiceURI) || null;
}

function speakSentence(text: string, settings: TTSSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      reject(new Error('Speech Synthesis not available'));
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    currentUtterance = utterance;

    const voice = settings.voice ? findVoice(settings.voice) : null;
    if (voice) utterance.voice = voice;
    utterance.rate = settings.rate;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onstart = () => {
      chrome.runtime.sendMessage({ type: 'SPEAKING_STARTED' } as OffscreenResponse);
    };

    utterance.onend = () => {
      currentUtterance = null;
      resolve();
    };

    utterance.onerror = (e) => {
      currentUtterance = null;
      reject(new Error(e.error));
    };

    window.speechSynthesis.speak(utterance);
  });
}

async function processQueue() {
  while (sentenceQueue.length > 0 && !isPaused) {
    const sentence = sentenceQueue.shift()!;
    
    chrome.runtime.sendMessage({
      type: 'SENTENCE_START',
      payload: { index: currentSentenceIndex, text: sentence },
    } as OffscreenResponse);

    try {
      await speakSentence(sentence, currentSettings);
      currentSentenceIndex++;
    } catch (error) {
      console.error('[Larynx Offscreen] Speech error:', error);
      chrome.runtime.sendMessage({ 
        type: 'ERROR', 
        payload: (error as Error).message 
      } as OffscreenResponse);
      break;
    }
  }

  if (sentenceQueue.length === 0) {
    chrome.runtime.sendMessage({ type: 'SPEAKING_ENDED' } as OffscreenResponse);
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'SPEAK': {
          const { text, settings } = message.payload;
          currentSettings = { ...currentSettings, ...settings };
          isPaused = false;
          currentSentenceIndex = 0;
          
          sentenceQueue = splitIntoSentences(text);
          
          if (sentenceQueue.length === 0) {
            sendResponse({ success: false, error: 'No valid sentences' });
            return;
          }

          sendResponse({ success: true });
          await processQueue();
          break;
        }

        case 'PAUSE': {
          if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
            isPaused = true;
          } else if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
            isPaused = false;
            await processQueue();
          }
          sendResponse({ success: true });
          break;
        }

        case 'RESUME': {
          if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
            isPaused = false;
            await processQueue();
          }
          sendResponse({ success: true });
          break;
        }

        case 'STOP': {
          window.speechSynthesis.cancel();
          sentenceQueue = [];
          isPaused = false;
          currentUtterance = null;
          sendResponse({ success: true });
          break;
        }

        case 'SET_RATE': {
          currentSettings.rate = message.payload;
          if (currentUtterance) {
            currentUtterance.rate = message.payload;
          }
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

        case 'GET_VOICES': {
          let voices = getVoices();
          if (voices.length === 0) {
            await new Promise<void>(resolve => {
              const handler = () => {
                window.speechSynthesis.removeEventListener('voiceschanged', handler);
                resolve();
              };
              window.speechSynthesis.addEventListener('voiceschanged', handler);
            });
            voices = getVoices();
          }
          sendResponse({ type: 'VOICES_LIST', payload: voices } as OffscreenResponse);
          break;
        }
      }
    } catch (error) {
      sendResponse({ 
        type: 'ERROR', 
        payload: (error as Error).message 
      } as OffscreenResponse);
    }
  })();

  return true;
});

console.log('[Larynx Offscreen] Loaded');

if (window.speechSynthesis.getVoices().length === 0) {
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    console.log('[Larynx Offscreen] Voices loaded');
  });
}
