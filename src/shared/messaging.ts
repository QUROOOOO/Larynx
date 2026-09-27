// Message passing utilities for Chrome extension

import { OffscreenMessage, OffscreenResponse, ContentMessage } from './types';

const OFFSCREEN_NOT_READY = 'Could not establish connection. Receiving end does not exist.';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sendToOffscreen(message: OffscreenMessage): Promise<OffscreenResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as OffscreenResponse);
      }
    });
  });
}

export function sendToContentScript(tabId: number, message: ContentMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

export async function hasOffscreenDocument(): Promise<boolean> {
  if (!chrome.offscreen) return false;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch {
    return false;
  }
}

/**
 * `chrome.offscreen.createDocument()` resolves once the document exists, but the
 * document's own `chrome.runtime.onMessage` listener is not registered yet. Sending
 * the first message immediately therefore fails with "Could not establish connection.
 * Receiving end does not exist." This pings until the offscreen script answers.
 */
async function waitForOffscreenReady(attempts: number, delayMs: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await sendToOffscreen({ type: 'PING' });
      if (response && (response as OffscreenResponse).type === 'PONG') return;
    } catch (error) {
      if (!(error as Error).message.includes(OFFSCREEN_NOT_READY)) throw error;
    }
    await delay(delayMs);
  }
  throw new Error('Offscreen document did not become ready in time');
}

export async function createOffscreenDocument(): Promise<void> {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/index.html',
      reasons: ['AUDIO_PLAYBACK' as chrome.offscreen.Reason],
      justification: 'Play TTS audio via Web Speech API',
    });
  }
  await waitForOffscreenReady(25, 20);
}

export async function closeOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Ignore errors if already closed
  }
}
