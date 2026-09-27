// Background Service Worker — Event-driven, no persistent loops

import { sendToOffscreen, sendToContentScript, hasOffscreenDocument, createOffscreenDocument, closeOffscreenDocument } from '../shared/messaging';
import { getSettings, onSettingsChange } from '../shared/storage';
import { ContentMessage } from '../shared/types';

let currentTabId: number | null = null;
// The tab that owns the running speech. Progress must be routed here rather than
// to whichever tab happens to be focused, or the highlight lands on the wrong page.
let speakingTabId: number | null = null;
let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null;
const OFFSCREEN_IDLE_MS = 30000;

// Callbacks waiting for the run that is currently speaking to actually terminate.
let drainWaiters: Array<() => void> = [];
// Upper bound on that wait, so a wedged offscreen document can never wedge the
// shortcut itself.
const DRAIN_TIMEOUT_MS = 3000;

// Run identity. Every read gets a fresh number and the offscreen document stamps
// its messages with it. Starting a new read therefore marks everything still in
// flight from the previous one as superseded, and those messages are dropped
// instead of being applied to the new read's page.
let activeRunId = 0;
let nextRunId = 1;

function resetOffscreenIdleTimer() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    closeOffscreenDocument();
    offscreenIdleTimer = null;
  }, OFFSCREEN_IDLE_MS);
}

/** Called from the handlers for the offscreen run's terminal messages. */
function releaseDrainWaiters(): void {
  const waiters = drainWaiters;
  drainWaiters = [];
  waiters.forEach((resolve) => resolve());
}

async function notifyContent(message: ContentMessage): Promise<void> {
  const tabId = speakingTabId ?? currentTabId;
  if (tabId === null) return;
  try {
    await sendToContentScript(tabId, message);
  } catch {
    // Content script not injected in this tab
  }
}

/** Strips the word highlight from one specific tab, ignoring delivery failures. */
function clearTabHighlight(tabId: number): void {
  void sendToContentScript(tabId, { type: 'SPEAK_ENDED' }).catch(() => {});
}

/**
 * Stops whatever is being read and waits until the offscreen document confirms
 * that run has finished.
 *
 * Waiting matters as much as stopping. The offscreen document only clears its
 * "busy" flag at the very end of a run, immediately *after* it reports
 * `SPEAKING_ENDED`. Once this resolves we know that message has been delivered
 * and handled, so its teardown of the previous page cannot arrive late and
 * destroy the highlight belonging to the run we are about to start.
 */
async function stopActiveRun(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;

  try {
    const status = await sendToOffscreen({ type: 'GET_STATUS' });
    if (status?.type !== 'STATUS' || !status.payload.speaking) return;
  } catch {
    return; // No live offscreen document, so there is nothing speaking.
  }

  try {
    await sendToOffscreen({ type: 'STOP' });
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    drainWaiters.push(finish);
    setTimeout(finish, DRAIN_TIMEOUT_MS);
  });
}

/**
 * Pressing the shortcut while speech is already running toggles pause instead of
 * starting a new request. Returns true when the press was consumed as a toggle.
 */
async function togglePlayback(): Promise<boolean> {
  if (!(await hasOffscreenDocument())) return false;

  let status;
  try {
    status = await sendToOffscreen({ type: 'GET_STATUS' });
  } catch {
    return false; // Offscreen document is gone; start fresh.
  }

  if (status?.type !== 'STATUS' || !status.payload.speaking) return false;

  await sendToOffscreen({ type: status.payload.paused ? 'RESUME' : 'PAUSE' });
  return true;
}

/**
 * Asks a tab whether it currently has a non-empty selection, without touching
 * the page. Restricted surfaces (chrome://, the web store) reject injection, in
 * which case we simply report "no selection" and fall through to the toggle.
 */
async function hasTextSelection(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.getSelection()?.toString() ?? '').trim().length > 0,
    });
    return result?.result === true;
  } catch {
    return false;
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'speak-selection') return;

  let tabId: number | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch (e) {
    console.error('[Larynx] Tab lookup failed:', e);
    return;
  }
  if (tabId === undefined) return;

  // A selection always wins. Reading new text is never ambiguous, so it must
  // interrupt whatever is currently being read instead of being swallowed by the
  // pause toggle — including when the previous run is sitting paused.
  if (await hasTextSelection(tabId)) {
    const previousTabId = speakingTabId;
    await stopActiveRun();
    if (previousTabId !== null && previousTabId !== tabId) {
      clearTabHighlight(previousTabId);
    }
    speakingTabId = null;
    currentTabId = tabId;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
    } catch (e) {
      console.error('[Larynx] Content script injection failed:', e);
    }
    return;
  }

  // Nothing selected: the shortcut is a pause/resume toggle while speaking, and
  // does nothing at all otherwise.
  try {
    if (await togglePlayback()) return;
  } catch (e) {
    console.error('[Larynx] Playback toggle failed:', e);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'SELECTION') {
        const { text, rect } = message.payload;
        if (!text.trim()) {
          sendResponse({ success: false, error: 'No text selected' });
          return;
        }

        // The sender is the content script holding the selection, so it is the
        // tab that must receive the word highlight.
        if (sender.tab?.id) {
          currentTabId = sender.tab.id;
          speakingTabId = sender.tab.id;
        }

        // From this instant anything still arriving from the previous read is
        // history, even if it has not reached us yet.
        const runId = nextRunId++;
        activeRunId = runId;

        const settings = await getSettings();
        await createOffscreenDocument();
        resetOffscreenIdleTimer();

        await sendToOffscreen({
          type: 'SPEAK',
          payload: { text, settings, selectionRect: rect, runId },
        });

        sendResponse({ success: true });
      } else if (message.type === 'SETTINGS_CHANGED') {
        sendResponse({ success: true });
      } else if (message.type === 'SENTENCE_START') {
        sendResponse({ success: true });
      } else if (message.type === 'WORD_PROGRESS') {
        // A word index from a read we have already replaced belongs to a page
        // that is no longer being highlighted. Applying it would paint a random
        // position on the new selection.
        if (message.runId === activeRunId) {
          await notifyContent({
            type: 'WORD_PROGRESS',
            payload: message.payload,
          });
        }
        sendResponse({ success: true });
      } else if (message.type === 'SPEAKING_STARTED') {
        sendResponse({ success: true });
      } else if (message.type === 'SPEAKING_ENDED') {
        // This is the outgoing teardown of a run that has been superseded, so it
        // must not clear the highlight of the read that replaced it. It still
        // ends the run we are waiting on, though.
        if (message.runId === activeRunId) {
          await notifyContent({ type: 'SPEAK_ENDED' });
          speakingTabId = null;
        }
        resetOffscreenIdleTimer();
        releaseDrainWaiters();
        sendResponse({ success: true });
      } else if (message.type === 'ERROR') {
        console.error('[Larynx] Speech error:', message.payload);
        if (message.runId === activeRunId) {
          await notifyContent({ type: 'SPEAK_ERROR', payload: { error: String(message.payload) } });
          speakingTabId = null;
        }
        resetOffscreenIdleTimer();
        releaseDrainWaiters();
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
