// Message passing utilities for Chrome extension

import { OffscreenMessage, OffscreenResponse, ContentMessage, PillAction } from './types';

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

export function sendToContentScript(tabId: number, message: ContentMessage): Promise<any> {
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

export function createPillAction(action: PillAction['action']): ContentMessage {
  return { type: 'PILL_ACTION', payload: { action } };
}

export async function hasOffscreenDocument(): Promise<boolean> {
  if (!chrome.offscreen) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function createOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/index.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play TTS audio via Web Speech API',
  });
}

export async function closeOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Ignore errors if already closed
  }
}
