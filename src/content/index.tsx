// Content Script — Injected on-demand via activeTab + chrome.scripting.executeScript
// Bundled as a self-contained IIFE (classic script, no ES module imports).
// Captures the selection, wraps it in per-word spans, and highlights as speech progresses.
// Safe to inject multiple times: persistent state lives on window.

import type { ContentMessage } from '../shared/types';

const WORD_CLASS = 'larynx-word';
const ACTIVE_CLASS = 'larynx-word-active';
const STYLE_ID = 'larynx-word-styles';

interface ContentState {
  wordSpans: HTMLElement[];
  lastText: string;
  run: () => void;
  cleanup: () => void;
}

declare global {
  interface Window {
    __larynx?: ContentState;
  }
}

/**
 * The extension's own stylesheet is only bundled into the options page, so the
 * highlight rules have to be injected into whichever host page is being read.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `.${WORD_CLASS}{border-radius:3px;transition:background-color .12s linear,box-shadow .12s linear}` +
    `.${ACTIVE_CLASS}{background-color:rgba(0,255,135,.35);box-shadow:0 0 0 1px rgba(0,255,135,.45)}`;
  (document.head || document.documentElement).appendChild(style);
}

function highlightWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  spans.forEach((span, i) => {
    const active = i === index;
    span.classList.toggle(ACTIVE_CLASS, active);
    span.style.background = active ? 'rgba(0,255,135,0.35)' : '';
  });
}

/** Every text node touched by the range, in document order. */
function collectTextNodes(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

/** Replaces the covered slice of one text node with per-word spans. */
function wrapTextNode(node: Text, start: number, end: number, spans: HTMLElement[]): void {
  const parent = node.parentNode;
  if (!parent) return;

  const covered = node.data.slice(start, end);
  if (!covered.trim()) return;

  const fragment = document.createDocumentFragment();

  // Preserve any text before the selection started.
  if (start > 0) {
    fragment.appendChild(document.createTextNode(node.data.slice(0, start)));
  }

  // Whitespace lives outside the spans so each span holds exactly one word and
  // its textContent matches what the speech engine reports.
  const words = covered.split(/\s+/).filter((w) => w.length > 0);
  words.forEach((word, i) => {
    if (i > 0) fragment.appendChild(document.createTextNode(' '));
    const span = document.createElement('span');
    span.className = WORD_CLASS;
    span.textContent = word;
    span.dataset.wordIndex = String(spans.length);
    spans.push(span);
    fragment.appendChild(span);
  });

  if (end < node.data.length) {
    fragment.appendChild(document.createTextNode(node.data.slice(end)));
  }

  parent.replaceChild(fragment, node);
}

/** Wraps every word of the current selection. Returns the flat, ordered span list. */
function wrapSelection(selection: Selection): HTMLElement[] {
  const spans: HTMLElement[] = [];
  if (selection.rangeCount === 0) return spans;

  const range = selection.getRangeAt(0);
  const nodes = collectTextNodes(range);

  nodes.forEach((node) => {
    // Live ranges re-index as the DOM changes underneath them, so snapshot offsets first.
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (end > start) {
      wrapTextNode(node, start, end, spans);
    }
  });

  return spans;
}

/** Undoes the wrapping so the page is left exactly as it was found. */
function unwrap(spans: HTMLElement[]): void {
  const parents = new Set<Node>();

  spans.forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    const next = span.nextSibling;
    if (next) parent.insertBefore(document.createTextNode(' '), next);
    parent.removeChild(span);
    parents.add(parent);
  });

  // Collapse the separator text nodes back into their neighbours.
  parents.forEach((parent) => parent.normalize());
}

if (!window.__larynx) {
  const state: ContentState = {
    wordSpans: [],
    lastText: '',
    run: () => {},
    cleanup: () => {},
  };

  window.__larynx = state;

  state.cleanup = () => {
    if (state.wordSpans.length > 0) {
      unwrap(state.wordSpans);
      state.wordSpans = [];
    }
    const style = document.getElementById(STYLE_ID);
    if (style?.parentNode) style.parentNode.removeChild(style);
  };

  state.run = () => {
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString().trim() : '';

    // With no live selection, repeat the last request so the shortcut keeps working
    // after the page has already been wrapped and unwrapped.
    if (!text && !state.lastText) return;

    state.cleanup();

    const activeText = text || state.lastText;
    state.lastText = activeText;

    if (text) {
      ensureStyles();
      state.wordSpans = wrapSelection(selection!);
    }

    chrome.runtime.sendMessage(
      { type: 'SELECTION', payload: { text: activeText, rect: selection?.getRangeAt(0).getBoundingClientRect() ?? null } },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Larynx] Speak request failed:', chrome.runtime.lastError.message);
          state.cleanup();
          return;
        }
        const result = response as { success?: boolean; error?: string } | undefined;
        if (result && result.success === false) {
          console.error('[Larynx] Speak request rejected:', result.error);
          state.cleanup();
        }
      },
    );
  };

  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
    switch (message.type) {
      case 'WORD_PROGRESS':
        highlightWord(state.wordSpans, message.payload.wordIndex);
        break;
      case 'SPEAK_ENDED':
        state.cleanup();
        break;
      case 'SPEAK_ERROR':
        console.error('[Larynx] Speech error:', message.payload.error);
        state.cleanup();
        break;
      case 'SETTINGS_CHANGED':
        // Rate and voice are forwarded straight to the offscreen document by the
        // background worker, so there is nothing to restart here.
        break;
      default:
        return false;
    }

    sendResponse({ success: true });
    return false;
  });

  state.run();
} else {
  window.__larynx.run();
}
