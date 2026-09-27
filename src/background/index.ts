// Background Service Worker — Event-driven, no persistent loops
// Wakes only on: chrome.commands, messages from content/offscreen/options

import { createOffscreenDocument, closeOffscreenDocument, sendToOffscreen, sendToContentScript } from '../shared/messaging';
import { getSettings, onSettingsChange } from '../shared/storage';

let currentTabId: number | null = null;
let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null;
const OFFSCREEN_IDLE_MS = 30000; // Close offscreen doc after 30s inactivity

function resetOffscreenIdleTimer() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    closeOffscreenDocument();
    offscreenIdleTimer = null;
  }, OFFSCREEN_IDLE_MS);
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

        const result = await sendToOffscreen({
          type: 'SPEAK',
          payload: { text, settings, selectionRect: rect },
        });

        sendResponse({ success: true, result });
      } else if (message.type === 'PILL_ACTION') {
        const action = message.payload.action;
        let offscreenMsg: any = null;

        switch (action) {
          case 'play_pause':
            offscreenMsg = { type: 'PAUSE' };
            break;
          case 'speed_up':
            offscreenMsg = { type: 'SET_RATE', payload: Math.min(2.0, (await getSettings()).rate + 0.25) };
            break;
          case 'speed_down':
            offscreenMsg = { type: 'SET_RATE', payload: Math.max(0.5, (await getSettings()).rate - 0.25) };
            break;
          case 'next_voice':
            offscreenMsg = { type: 'GET_VOICES' };
            break;
          case 'dismiss':
            await sendToOffscreen({ type: 'STOP' });
            closeOffscreenDocument();
            if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
            break;
        }

        if (offscreenMsg) {
          await sendToOffscreen(offscreenMsg);
        }
        sendResponse({ success: true });
      } else if (message.type === 'SETTINGS_CHANGED') {
        await getSettings();
        sendResponse({ success: true });
      }
    } catch (error) {
      sendResponse({ success: false, error: (error as Error).message });
    }
  })();

  return true;
});

// Handle messages from offscreen document (speech events)
chrome.runtime.onMessageExternal.addListener((message, sender, _sendResponse) => {
  // Only accept messages from our own offscreen document
  if (sender.id !== chrome.runtime.id) return;

  if (message.type === 'SPEAKING_ENDED') {
    // Speech finished - reset idle timer to close offscreen doc soon
    resetOffscreenIdleTimer();
  } else if (message.type === 'SENTENCE_START' && currentTabId) {
    // Forward sentence progress to content script for pill UI
    sendToContentScript(currentTabId, {
      type: 'SENTENCE_PROGRESS',
      payload: { sentenceIndex: message.payload.index, sentenceText: message.payload.text },
    });
  }
});

// Listen for storage changes from options page
onSettingsChange((newSettings) => {
  // Notify offscreen document of settings change if it exists
  createOffscreenDocument().then(() => {
    sendToOffscreen({ type: 'SET_RATE', payload: newSettings.rate });
    if (newSettings.voice) {
      sendToOffscreen({ type: 'SET_VOICE', payload: newSettings.voice });
    }
  });
});

// Cleanup on extension unload
chrome.runtime.onSuspend.addListener(() => {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  closeOffscreenDocument();
});

console.log('[Larynx] Background service worker loaded');
