// Background Service Worker — Event-driven, no persistent loops

import { sendToOffscreen, sendToContentScript, hasOffscreenDocument, createOffscreenDocument, closeOffscreenDocument } from '../shared/messaging';
import { getSettings, onSettingsChange } from '../shared/storage';
import { ContentMessage } from '../shared/types';

let currentTabId: number | null = null;
let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null;
const OFFSCREEN_IDLE_MS = 30000;

function resetOffscreenIdleTimer() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    closeOffscreenDocument();
    offscreenIdleTimer = null;
  }, OFFSCREEN_IDLE_MS);
}

async function notifyContent(message: ContentMessage): Promise<void> {
  if (currentTabId === null) return;
  try {
    await sendToContentScript(currentTabId, message);
  } catch {
    // Content script not injected in this tab
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'speak-selection') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  currentTabId = tab.id;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (e) {
    console.error('[Larynx] Content script injection failed:', e);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'SELECTION') {
        const { text, rect } = message.payload;
        if (!text.trim()) {
          sendResponse({ success: false, error: 'No text selected' });
          return;
        }

        const settings = await getSettings();
        await createOffscreenDocument();
        resetOffscreenIdleTimer();

        await sendToOffscreen({
          type: 'SPEAK',
          payload: { text, settings, selectionRect: rect },
        });

        sendResponse({ success: true });
      } else if (message.type === 'SETTINGS_CHANGED') {
        sendResponse({ success: true });
      } else if (message.type === 'SENTENCE_START') {
        sendResponse({ success: true });
      } else if (message.type === 'WORD_PROGRESS') {
        if (currentTabId !== null) {
          await notifyContent({
            type: 'WORD_PROGRESS',
            payload: message.payload,
          });
        }
        sendResponse({ success: true });
      } else if (message.type === 'SPEAKING_STARTED') {
        sendResponse({ success: true });
      } else if (message.type === 'SPEAKING_ENDED') {
        await notifyContent({ type: 'SPEAK_ENDED' });
        resetOffscreenIdleTimer();
        sendResponse({ success: true });
      } else if (message.type === 'ERROR') {
        console.error('[Larynx] Speech error:', message.payload);
        await notifyContent({ type: 'SPEAK_ERROR', payload: { error: String(message.payload) } });
        resetOffscreenIdleTimer();
        sendResponse({ success: false, error: String(message.payload) });
      } else {
        sendResponse({ success: true });
      }
    } catch (error) {
      sendResponse({ success: false, error: (error as Error).message });
    }
  })();

  return true;
});

onSettingsChange(async (newSettings) => {
  try {
    if (!(await hasOffscreenDocument())) return;
    await sendToOffscreen({ type: 'SET_RATE', payload: newSettings.rate });
    if (newSettings.voice) {
      await sendToOffscreen({ type: 'SET_VOICE', payload: newSettings.voice });
    }
  } catch {
    // Offscreen document closed
  }
});

console.log('[Larynx] Background service worker loaded');
