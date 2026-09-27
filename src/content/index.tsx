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
 *
 * The selectors are deliberately specific and the colour declarations carry
 * `!important` so an aggressive host-page reset (or a site that colours spans)
 * cannot leave the word highlight invisible.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${WORD_CLASS} {
      border-radius: 4px !important;
      padding: 0 1px !important;
      margin: 0 -1px !important;
      background-color: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      outline: none !important;
      color: inherit !important;
      text-decoration: none !important;
      transition: background-color .12s linear, box-shadow .12s linear;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .${ACTIVE_CLASS} {
      background-color: rgba(0, 255, 135, 0.32) !important;
      background-image: none !important;
      box-shadow: inset 0 -2px 0 0 rgba(0, 255, 135, 0.9), 0 0 0 1px rgba(0, 255, 135, 0.55), 0 0 12px rgba(0, 255, 135, 0.35) !important;
      border-radius: 4px !important;
    }`;
  (document.head || document.documentElement).appendChild(style);
}

function highlightWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  for (let i = 0; i < spans.length; i++) {
    spans[i].classList.toggle(ACTIVE_CLASS, i === index);
  }
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

/**
 * Replaces the covered slice of one text node with per-word spans.
 *
 * Every character of the original slice is preserved verbatim: the text between
 * words (and any leading/trailing whitespace) is emitted as real text nodes using
 * the exact original substring, never a normalised " ". Collapsing the separators
 * would visibly rewrite the host page's text once the spans are unwrapped.
 */
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

  // Walk the word matches and copy the gaps between them through untouched, so
  // each span holds exactly one word and the separators keep their original form.
  const wordPattern = /\S+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(covered)) !== null) {
    if (match.index > cursor) {
      fragment.appendChild(document.createTextNode(covered.slice(cursor, match.index)));
    }
    const span = document.createElement('span');
    span.className = WORD_CLASS;
    span.textContent = match[0];
    span.dataset.wordIndex = String(spans.length);
    spans.push(span);
    fragment.appendChild(span);
    cursor = match.index + match[0].length;
  }

  if (cursor < covered.length) {
    fragment.appendChild(document.createTextNode(covered.slice(cursor)));
  }

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

/**
 * Undoes the wrapping so the page is left byte-for-byte as it was found.
 *
 * The separators between words are real text nodes, so each span simply becomes a
 * plain text node again. No separator is synthesised here — inserting one would
 * change the rendered text of the host page.
 */
function unwrap(spans: HTMLElement[]): void {
  const parents = new Set<Node>();

  spans.forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(span.textContent || ''), span);
    parents.add(parent);
  });

  // Merge the adjacent text nodes that used to be one.
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

    // Wrapping replaces the very nodes the range points at, so the on-screen
    // rectangle has to be read before the DOM is touched.
    let rect: DOMRect | null = null;
    if (text && selection && selection.rangeCount > 0) {
      try {
        rect = selection.getRangeAt(0).getBoundingClientRect();
      } catch {
        rect = null;
      }
    }

    state.cleanup();

    const activeText = text || state.lastText;
    state.lastText = activeText;

    if (text) {
      ensureStyles();
      state.wordSpans = wrapSelection(selection!);
    }

    chrome.runtime.sendMessage(
      { type: 'SELECTION', payload: { text: activeText, rect } },
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
