// Content Script — Injected on-demand via activeTab + chrome.scripting.executeScript
// Bundled as a self-contained IIFE (classic script, no ES module imports).
// Handles word-level highlighting as speech progresses.
// Safe to inject multiple times: persistent state lives on window.

import type { ContentMessage } from '../shared/types';

interface ContentState {
  wordSpans: HTMLElement[];
  currentSentenceIndex: number;
  run: () => void;
  cleanup: () => void;
}

declare global {
  interface Window {
    __larynx?: ContentState;
  }
}

function clearHighlights(): void {
  document.querySelectorAll<HTMLElement>('.larynx-word').forEach((el) => {
    el.classList.remove('larynx-word', 'larynx-word-active');
    el.style.background = '';
  });
}

function highlightWord(spans: HTMLElement[], index: number): void {
  spans.forEach((s, i) => {
    s.classList.toggle('larynx-word-active', i === index);
    s.style.background = i === index ? 'rgba(0,255,135,0.35)' : '';
  });
}

function wrapWords(text: string): HTMLElement[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const spans: HTMLElement[] = [];
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return spans;

  const container = sel.getRangeAt(0).commonAncestorContainer;
  if (!container || container.nodeType !== Node.TEXT_NODE) return spans;
  const parent = container.parentElement;
  if (!parent) return spans;

  const frag = document.createDocumentFragment();
  words.forEach((word, i) => {
    const span = document.createElement('span');
    span.className = 'larynx-word';
    span.textContent = (i > 0 ? ' ' : '') + word;
    span.dataset.wordIndex = String(i);
    spans.push(span);
    frag.appendChild(span);
  });

  const textNode = container;
  const next = textNode.nextSibling;
  parent.insertBefore(frag, textNode);
  parent.removeChild(textNode);
  if (next) parent.insertBefore(next, frag.nextSibling);

  return spans;
}

if (!window.__larynx) {
  const state: ContentState = {
    wordSpans: [],
    currentSentenceIndex: -1,
    run: () => {},
    cleanup: () => {},
  };
  window.__larynx = state;

  state.cleanup = () => {
    clearHighlights();
    state.wordSpans = [];
    state.currentSentenceIndex = -1;
  };

  state.run = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;

    state.cleanup();
    state.wordSpans = wrapWords(text);
    chrome.runtime.sendMessage({
      type: 'SELECTION',
      payload: { text, rect: sel.getRangeAt(0).getBoundingClientRect() },
    });
  };

  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
    if (message.type === 'SENTENCE_PROGRESS') {
      state.currentSentenceIndex = (message.payload as { sentenceIndex: number }).sentenceIndex;
      sendResponse({ success: true });
      return false;
    }
    if (message.type === 'WORD_PROGRESS') {
      const payload = message.payload as { wordIndex: number; sentenceIndex: number; wordText: string };
      if (payload.sentenceIndex === state.currentSentenceIndex && state.wordSpans.length > 0) {
        highlightWord(state.wordSpans, payload.wordIndex);
      }
      sendResponse({ success: true });
      return false;
    }
    if (message.type === 'SETTINGS_CHANGED') {
      state.run();
      sendResponse({ success: true });
      return false;
    }
    return undefined;
  });

  window.__larynx = state;
  state.run();
} else {
  window.__larynx.run();
}
