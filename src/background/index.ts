// Background Service Worker — Event-driven, no persistent loops
// Wakes only on: chrome.commands, messages from content/offscreen/options

import { createOffscreenDocument, closeOffscreenDocument, sendToOffscreen, sendToContentScript, hasOffscreenDocument } from '../shared/messaging';
import { getSettings, setSettings, onSettingsChange } from '../shared/storage';
import { ContentMessage } from '../shared/types';

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

async function notifyContent(message: ContentMessage): Promise<void> {
  if (currentTabId === null) return;
  try {
    await sendToContentScript(currentTabId, message);
  } catch {
    // Content script not injected in this tab (or page navigated away)
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

        const result = await sendToOffscreen({
          type: 'SPEAK',
          payload: { text, settings, selectionRect: rect },
        });

        await notifyContent({ type: 'PILL_STATE', payload: { rate: settings.rate, isPlaying: true } });
        sendResponse({ success: true, result });
      } else if (message.type === 'PILL_ACTION') {
        const action = message.payload.action;

        if (action === 'play_pause') {
          const resp = (await sendToOffscreen({ type: 'PAUSE' })) as { paused?: boolean };
          if (typeof resp?.paused === 'boolean') {
            await notifyContent({ type: 'PILL_STATE', payload: { isPlaying: !resp.paused } });
          }
        } else if (action === 'speed_up' || action === 'speed_down') {
          const current = await getSettings();
          const delta = action === 'speed_up' ? 0.25 : -0.25;
          const newRate = Math.min(2.0, Math.max(0.5, Math.round((current.rate + delta) * 100) / 100));
          await setSettings({ rate: newRate });
          await sendToOffscreen({ type: 'SET_RATE', payload: newRate });
          await notifyContent({ type: 'PILL_STATE', payload: { rate: newRate } });
        } else if (action === 'next_voice') {
          await sendToOffscreen({ type: 'GET_VOICES' });
        } else if (action === 'dismiss') {
          await sendToOffscreen({ type: 'STOP' });
          await closeOffscreenDocument();
          if (offscreenIdleTimer) {
            clearTimeout(offscreenIdleTimer);
            offscreenIdleTimer = null;
          }
          await notifyContent({ type: 'HIDE_PILL' });
        }

        sendResponse({ success: true });
      } else if (message.type === 'SETTINGS_CHANGED') {
        await getSettings();
        sendResponse({ success: true });
      } else if (message.type === 'SENTENCE_START') {
        // Offscreen sends: { index: number, text: string }
        if (message.payload?.index !== undefined && currentTabId !== null) {
          await notifyContent({
            type: 'SENTENCE_PROGRESS',
            payload: { sentenceIndex: message.payload.index, sentenceText: message.payload.text },
          });
        }
        sendResponse({ success: true });
      } else if (message.type === 'SPEAKING_STARTED') {
        await notifyContent({ type: 'PILL_STATE', payload: { isPlaying: true } });
        sendResponse({ success: true });
      } else if (message.type === 'SPEAKING_ENDED') {
        // Speech finished — reset idle timer to close offscreen doc soon
        resetOffscreenIdleTimer();
        await notifyContent({ type: 'PILL_STATE', payload: { isPlaying: false } });
        sendResponse({ success: true });
      } else if (message.type === 'ERROR') {
        console.error('[Larynx] Speech error:', message.payload);
        resetOffscreenIdleTimer();
        await notifyContent({ type: 'PILL_STATE', payload: { isPlaying: false } });
        sendResponse({ success: false, error: String(message.payload) });
      } else {
        // Always respond so senders never hit "message port closed"
        sendResponse({ success: true });
      }
    } catch (error) {
      sendResponse({ success: false, error: (error as Error).message });
    }
  })();

  return true;
});

// Sync offscreen state when settings change (options page, pill speed buttons)
onSettingsChange(async (newSettings) => {
  try {
    if (!(await hasOffscreenDocument())) return;
    await sendToOffscreen({ type: 'SET_RATE', payload: newSettings.rate });
    if (newSettings.voice) {
      await sendToOffscreen({ type: 'SET_VOICE', payload: newSettings.voice });
    }
  } catch {
    // Offscreen document closed between check and send
  }
});

console.log('[Larynx] Background service worker loaded');
