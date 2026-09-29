// Content Script — Injected on-demand via activeTab + chrome.scripting.executeScript
// Bundled as a self-contained IIFE (classic script, no ES module imports).
// Captures the selection, wraps it in per-word spans, and highlights as speech progresses.
// Safe to inject multiple times: persistent state lives on window.
// v1.3.1

import { prepareSpeech } from '../shared/text-utils';
import type { ContentMessage } from '../shared/types';

const WORD_CLASS = 'larynx-word';
const GAP_CLASS = 'larynx-gap';
const ACTIVE_CLASS = 'larynx-word-active';
const STYLE_ID = 'larynx-word-styles';
const PILL_ID = 'larynx-liquid-pill';

let currentIndex = -1;
let lastTop: number | null = null;

interface ContentState {
  wordSpans: HTMLElement[];
  injected: HTMLElement[];
  spokenToSource: number[];
  run: () => void;
  cleanup: () => void;
}

declare global {
  interface Window {
    __larynx?: ContentState;
  }
}

/**
 * Inject base styles.
 *
 * KEY DESIGN: Colors are NOT set here via CSS. They are applied as inline
 * styles directly on each word span at highlight time. This sidesteps all
 * CSS stacking-context and z-index ordering issues — the span owns both its
 * background and its text color, no separate z-index battle needed.
 *
 * The pill is purely a visual decoration (the liquid sliding animation).
 * It carries NO color that could conflict with the span's text.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${WORD_CLASS},
    .${GAP_CLASS} {
      background-color: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      outline: none !important;
      border: none !important;
      text-decoration: none !important;
      padding: 0 2px !important;
      margin: 0 !important;
      border-radius: 3px !important;
      opacity: 1 !important;
      display: inline !important;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .${WORD_CLASS}.${ACTIVE_CLASS} {
      /* Colors injected via inline style at runtime — see paintWord() */
    }
    .${WORD_CLASS}::selection,
    .${GAP_CLASS}::selection {
      background-color: transparent !important;
      color: inherit !important;
    }
    #${PILL_ID} {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      pointer-events: none !important;
      opacity: 0 !important;
      border-radius: 3px !important;
      box-sizing: border-box !important;
      /* Pill is invisible — colors live on the span, not here */
      z-index: 1 !important;
      will-change: transform, width, height !important;
      transition: transform 0.13s cubic-bezier(0.25, 1, 0.5, 1),
                  width 0.13s cubic-bezier(0.25, 1, 0.5, 1),
                  height 0.10s ease !important;
    }`;
  (document.head || document.documentElement).appendChild(style);
}

function getOrCreatePill(): HTMLElement {
  let pill = document.getElementById(PILL_ID);
  if (!pill) {
    pill = document.createElement('div');
    pill.id = PILL_ID;
    document.documentElement.appendChild(pill);
  }
  return pill;
}

/** Parse "rgb(r, g, b)" or "rgba(r,g,b,a)" → [r,g,b]. Returns null on failure. */
function parseRGB(color: string): [number, number, number] | null {
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) return null;
  return [parseInt(m[0], 10), parseInt(m[1], 10), parseInt(m[2], 10)];
}

/** rgb(255-r, 255-g, 255-b) — mathematical color inverse. */
function invertRGB([r, g, b]: [number, number, number]): string {
  return `rgb(${255 - r}, ${255 - g}, ${255 - b})`;
}

/**
 * Walk up the DOM to find the first solid (non-transparent) background color.
 * Falls back to rgb(255,255,255) if none found (white page assumption).
 */
function getEffectiveBg(el: HTMLElement): [number, number, number] {
  let curr: HTMLElement | null = el.parentElement; // start from parent, not el itself
  while (curr) {
    const bg = window.getComputedStyle(curr).backgroundColor;
    // Accept any non-transparent color
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      // Guard: reject nearly-invisible alpha, e.g. "rgba(0,0,0,0.05)"
      const rgba = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (rgba) {
        const alpha = rgba[4] ? parseFloat(rgba[4]) : 1;
        if (alpha > 0.5) {
          return [parseInt(rgba[1], 10), parseInt(rgba[2], 10), parseInt(rgba[3], 10)];
        }
      }
    }
    if (curr === document.documentElement) break;
    curr = curr.parentElement;
  }
  return [255, 255, 255]; // safe default: assume white page
}

/**
 * Highlights the word at `index` with its true negative color.
 *
 * Colors are applied DIRECTLY on the <span> element as inline styles:
 *   span.style.backgroundColor = invertRGB(page background) → e.g. black on Wikipedia
 *   span.style.color           = invertRGB(page text color)  → e.g. white on Wikipedia
 *
 * This is the only reliable way on arbitrary third-party pages.
 * A separate fixed-position pill with z-index would fight the page's own
 * stacking contexts and paint OVER the span's text (making text invisible).
 * By putting everything on the span itself, there is no z-index conflict.
 */
function paintWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;

  // Clear the previous active word
  if (currentIndex >= 0 && currentIndex < spans.length && currentIndex !== index) {
    const prev = spans[currentIndex];
    prev.classList.remove(ACTIVE_CLASS);
    prev.style.removeProperty('background-color');
    prev.style.removeProperty('color');
    prev.style.removeProperty('border-radius');
    prev.style.removeProperty('padding');
  }

  const el = spans[index];
  if (!el) return;

  // Compute the inverted colors from the live page style
  let bgInverted = 'rgb(0, 0, 0)';     // fallback: black bg (good for light pages)
  let textInverted = 'rgb(255, 255, 255)'; // fallback: white text

  try {
    const textRGB = parseRGB(window.getComputedStyle(el).color);
    const bgRGB = getEffectiveBg(el);

    bgInverted = invertRGB(bgRGB);                               // e.g. black on white pages
    textInverted = textRGB ? invertRGB(textRGB) : 'rgb(255,255,255)'; // e.g. white on black pill
  } catch {
    // Keep fallback values
  }

  // Apply colors directly on the span — zero z-index fight, always visible
  el.classList.add(ACTIVE_CLASS);
  el.style.setProperty('background-color', bgInverted, 'important');
  el.style.setProperty('color', textInverted, 'important');
  el.style.setProperty('border-radius', '3px', 'important');
  el.style.setProperty('padding', '0 2px', 'important');

  currentIndex = index;

  // Slide the pill indicator (decorative — carries no color, just tracks position)
  try {
    const pill = getOrCreatePill();
    const rect = el.getBoundingClientRect();
    const padX = 2;
    const padY = 1;
    const targetX = Math.round(rect.left - padX);
    const targetY = Math.round(rect.top - padY);
    const targetW = Math.max(8, Math.round(rect.width + padX * 2));
    const targetH = Math.max(14, Math.round(rect.height + padY * 2));

    const isLineBreak = lastTop !== null && Math.abs(targetY - lastTop) > 8;

    if (isLineBreak || lastTop === null) {
      pill.style.setProperty('transition', 'none', 'important');
      pill.style.setProperty('transform', `translate3d(${targetX}px, ${targetY}px, 0)`, 'important');
      pill.style.setProperty('width', `${targetW}px`, 'important');
      pill.style.setProperty('height', `${targetH}px`, 'important');
      void pill.offsetWidth; // flush reflow so snap takes effect before re-enabling transition
      pill.style.removeProperty('transition');
    } else {
      pill.style.setProperty('transform', `translate3d(${targetX}px, ${targetY}px, 0)`, 'important');
      pill.style.setProperty('width', `${targetW}px`, 'important');
      pill.style.setProperty('height', `${targetH}px`, 'important');
    }
    lastTop = targetY;

    // Auto-scroll word into view
    const inView =
      rect.top >= 16 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) - 16;
    if (!inView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch {
    // Ignore layout errors
  }
}

/** Reposition pill on scroll (pill tracks span position, is position:fixed) */
function updatePillOnScroll(): void {
  if (currentIndex < 0) return;
  const state = window.__larynx;
  if (!state || currentIndex >= state.wordSpans.length) return;
  const el = state.wordSpans[currentIndex];
  if (!el) return;

  try {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;
    const rect = el.getBoundingClientRect();
    const padX = 2;
    const padY = 1;
    pill.style.setProperty('transition', 'none', 'important');
    pill.style.setProperty('transform', `translate3d(${Math.round(rect.left - padX)}px, ${Math.round(rect.top - padY)}px, 0)`, 'important');
    pill.style.setProperty('width', `${Math.max(8, Math.round(rect.width + padX * 2))}px`, 'important');
    pill.style.setProperty('height', `${Math.max(14, Math.round(rect.height + padY * 2))}px`, 'important');
    lastTop = Math.round(rect.top - padY);
    void pill.offsetWidth;
    pill.style.removeProperty('transition');
  } catch {
    // ignore
  }
}

let scrollListenerAdded = false;
function armScrollListener(): void {
  if (scrollListenerAdded) return;
  scrollListenerAdded = true;
  window.addEventListener('scroll', updatePillOnScroll, { passive: true, capture: true });
  window.addEventListener('resize', updatePillOnScroll, { passive: true });
}

function removeScrollListener(): void {
  if (!scrollListenerAdded) return;
  scrollListenerAdded = false;
  window.removeEventListener('scroll', updatePillOnScroll, { capture: true });
  window.removeEventListener('resize', updatePillOnScroll);
}

function highlightWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  paintWord(spans, index);
}

function sourceIndexFor(state: ContentState, spokenIndex: number): number | undefined {
  if (state.spokenToSource.length === 0) return spokenIndex;
  return state.spokenToSource[spokenIndex];
}

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

function wrapTextNode(
  node: Text,
  start: number,
  end: number,
  spans: HTMLElement[],
  injected: HTMLElement[],
): void {
  const parent = node.parentNode;
  if (!parent) return;

  const covered = node.data.slice(start, end);
  if (!covered.trim()) return;

  const fragment = document.createDocumentFragment();

  if (start > 0) {
    fragment.appendChild(document.createTextNode(node.data.slice(0, start)));
  }

  const appendGap = (value: string) => {
    if (!value) return;
    const gap = document.createElement('span');
    gap.className = GAP_CLASS;
    gap.textContent = value;
    injected.push(gap);
    fragment.appendChild(gap);
  };

  const wordPattern = /\S+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(covered)) !== null) {
    appendGap(covered.slice(cursor, match.index));
    const span = document.createElement('span');
    span.className = WORD_CLASS;
    span.textContent = match[0];
    span.dataset.wordIndex = String(spans.length);
    spans.push(span);
    injected.push(span);
    fragment.appendChild(span);
    cursor = match.index + match[0].length;
  }

  appendGap(covered.slice(cursor));

  if (end < node.data.length) {
    fragment.appendChild(document.createTextNode(node.data.slice(end)));
  }

  parent.replaceChild(fragment, node);
}

function wrapRange(range: Range): { words: HTMLElement[]; injected: HTMLElement[] } {
  const spans: HTMLElement[] = [];
  const injected: HTMLElement[] = [];
  const nodes = collectTextNodes(range);
  if (nodes.length === 0) return { words: spans, injected };

  const startContainer = range.startContainer;
  const startOffset = range.startOffset;
  const endContainer = range.endContainer;
  const endOffset = range.endOffset;

  nodes.forEach((node) => {
    const start = node === startContainer ? startOffset : 0;
    const end = node === endContainer ? endOffset : node.data.length;
    if (end > start) {
      wrapTextNode(node, start, end, spans, injected);
    }
  });

  return { words: spans, injected };
}

function unwrap(spans: HTMLElement[]): void {
  const parents = new Set<Node>();
  spans.forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(span.textContent || ''), span);
    parents.add(parent);
  });
  parents.forEach((parent) => parent.normalize());
}

if (!window.__larynx) {
  const state: ContentState = {
    wordSpans: [],
    injected: [],
    spokenToSource: [],
    run: () => {},
    cleanup: () => {},
  };

  window.__larynx = state;

  state.cleanup = () => {
    if (currentIndex >= 0 && currentIndex < state.wordSpans.length) {
      const prev = state.wordSpans[currentIndex];
      if (prev) {
        prev.classList.remove(ACTIVE_CLASS);
        prev.style.removeProperty('background-color');
        prev.style.removeProperty('color');
        prev.style.removeProperty('border-radius');
        prev.style.removeProperty('padding');
      }
    }
    currentIndex = -1;
    lastTop = null;

    const pill = document.getElementById(PILL_ID);
    if (pill?.parentNode) pill.parentNode.removeChild(pill);

    removeScrollListener();

    if (state.injected.length > 0) {
      unwrap(state.injected);
      state.injected = [];
    }
    state.wordSpans = [];
    state.spokenToSource = [];

    const styleEl = document.getElementById(STYLE_ID);
    if (styleEl?.parentNode) styleEl.parentNode.removeChild(styleEl);
  };

  state.run = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0).cloneRange();
    const text = range.toString().trim();
    if (!text) return;

    let rect: DOMRect | null = null;
    try {
      rect = range.getBoundingClientRect();
    } catch {
      rect = null;
    }

    state.cleanup();

    const plan = prepareSpeech(text);
    state.spokenToSource = plan.spokenToSource;

    if (!plan.text) {
      state.spokenToSource = [];
      return;
    }

    ensureStyles();
    const wrapped = wrapRange(range);
    state.wordSpans = wrapped.words;
    state.injected = wrapped.injected;

    armScrollListener();

    try {
      selection.removeAllRanges();
    } catch {
      // ignore
    }

    chrome.runtime.sendMessage(
      { type: 'SELECTION', payload: { text: plan.text, rect } },
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
      case 'WORD_PROGRESS': {
        const source = sourceIndexFor(state, message.payload.wordIndex);
        if (source !== undefined) highlightWord(state.wordSpans, source);
        break;
      }
      case 'SPEAK_ENDED':
        state.cleanup();
        break;
      case 'SPEAK_ERROR':
        console.error('[Larynx] Speech error:', message.payload.error);
        state.cleanup();
        break;
      case 'SETTINGS_CHANGED':
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
