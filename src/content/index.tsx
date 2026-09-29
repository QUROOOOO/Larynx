// Content Script — Injected on-demand via activeTab + chrome.scripting.executeScript
// Bundled as a self-contained IIFE (classic script, no ES module imports).
// Captures the selection, wraps it in per-word spans, and highlights as speech progresses.
// Safe to inject multiple times: persistent state lives on window.
// v1.3.0

import { prepareSpeech } from '../shared/text-utils';
import type { ContentMessage } from '../shared/types';

const WORD_CLASS = 'larynx-word';
const GAP_CLASS = 'larynx-gap';
const ACTIVE_CLASS = 'larynx-word-active';
const STYLE_ID = 'larynx-word-styles';
const PILL_ID = 'larynx-liquid-pill';

/** Index of the word currently carrying the active class, or -1. */
let currentIndex = -1;
let lastTop: number | null = null;

interface ContentState {
  /** Word spans only — indexes are what `WORD_PROGRESS` addresses. */
  wordSpans: HTMLElement[];
  /** Every span this script injected, so cleanup can restore the page exactly. */
  injected: HTMLElement[];
  /**
   * Bridges the two texts. The engine speaks the normalized plan while the
   * page shows the original selection, so a spoken index only means anything
   * once it is translated through this map back to a `wordSpans` index.
   */
  spokenToSource: number[];
  run: () => void;
  cleanup: () => void;
}

declare global {
  interface Window {
    __larynx?: ContentState;
  }
}

// v1.3.0

/**
 * Inject styles for the word spans and the liquid sliding pill.
 *
 * The active word gets its text color set to the mathematical inverse of the
 * page’s own text color, and the pill behind it gets the inverse of the page’s
 * background. This is computed at runtime from getComputedStyle, so it works
 * on every website — light, dark, or any arbitrary color palette.
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
      padding: 0 1px !important;
      margin: 0 !important;
      border-radius: 4px !important;
      opacity: 1 !important;
      display: inline !important;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .${WORD_CLASS}.${ACTIVE_CLASS} {
      position: relative !important;
      z-index: 999995 !important;
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
      border-radius: 4px !important;
      box-sizing: border-box !important;
      z-index: 999990 !important;
      will-change: transform, width, height, opacity !important;
      transition: transform 0.14s cubic-bezier(0.25, 1, 0.5, 1),
                  width 0.14s cubic-bezier(0.25, 1, 0.5, 1),
                  height 0.10s ease,
                  opacity 0.08s ease !important;
    }`;
  (document.head || document.documentElement).appendChild(style);
}

function getOrCreateLiquidPill(): HTMLElement {
  let pill = document.getElementById(PILL_ID);
  if (!pill) {
    pill = document.createElement('div');
    pill.id = PILL_ID;
    document.documentElement.appendChild(pill);
  }
  return pill;
}

/**
 * Parses an rgb/rgba string into [r,g,b]. Returns null if not parseable.
 */
function parseRGB(color: string): [number, number, number] | null {
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) return null;
  return [parseInt(m[0], 10), parseInt(m[1], 10), parseInt(m[2], 10)];
}

/**
 * Returns the CSS `rgb(...)` string for the mathematical inverse of a color.
 */
function invertRGB(rgb: [number, number, number]): string {
  return `rgb(${255 - rgb[0]}, ${255 - rgb[1]}, ${255 - rgb[2]})`;
}

/**
 * Walks up the DOM to find the first non-transparent background color.
 * Falls back to white (light pages) if none found.
 */
function getEffectiveBg(el: HTMLElement): [number, number, number] {
  let curr: HTMLElement | null = el;
  while (curr && curr !== document.documentElement) {
    const bg = window.getComputedStyle(curr).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      const parsed = parseRGB(bg);
      // Skip nearly-transparent rgba (alpha close to 0)
      if (parsed && !bg.startsWith('rgba(0, 0, 0, 0')) {
        return parsed;
      }
    }
    curr = curr.parentElement;
  }
  // Try body / html
  for (const root of [document.body, document.documentElement]) {
    if (!root) continue;
    const bg = window.getComputedStyle(root).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      const parsed = parseRGB(bg);
      if (parsed) return parsed;
    }
  }
  return [255, 255, 255]; // Default: white page
}

/**
 * Paints the active word with a liquid sliding pill that shows the true negative
 * of the page’s own color palette.
 *
 * How it works:
 *   1. Read the element’s computed text color and effective background color.
 *   2. Invert both: rgb(255-r, 255-g, 255-b).
 *   3. Apply inverted-background to the pill behind the word.
 *   4. Apply inverted-text-color to the word text itself.
 *
 * Result on any site:
 *   White page + black text  →  black pill + white word text  ✓
 *   Dark page + white text   →  white pill + black word text  ✓
 *   Blue link text on white  →  black pill + orange word text ✓
 */
function paintWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;

  // Un-highlight previous word
  if (currentIndex >= 0 && currentIndex < spans.length && currentIndex !== index) {
    const prev = spans[currentIndex];
    prev.classList.remove(ACTIVE_CLASS);
    prev.style.removeProperty('color');
    prev.style.removeProperty('position');
    prev.style.removeProperty('z-index');
  }

  const el = spans[index];
  if (!el) return;

  el.classList.add(ACTIVE_CLASS);

  // Read current computed colors and invert them for the highlight
  try {
    const textRGB = parseRGB(window.getComputedStyle(el).color);
    const bgRGB = getEffectiveBg(el);

    // Pill = inverse of page background (dark on light pages, light on dark pages)
    const pillColor = invertRGB(bgRGB);
    // Word text = inverse of original text color (readable against the inverted pill)
    const wordTextColor = textRGB ? invertRGB(textRGB) : invertRGB(bgRGB);

    const pill = getOrCreateLiquidPill();
    pill.style.setProperty('background-color', pillColor, 'important');
    el.style.setProperty('color', wordTextColor, 'important');
  } catch {
    // Fallback: black pill, white text (works on almost all light pages)
    const pill = getOrCreateLiquidPill();
    pill.style.setProperty('background-color', '#000000', 'important');
    el.style.setProperty('color', '#ffffff', 'important');
  }

  el.style.setProperty('position', 'relative', 'important');
  el.style.setProperty('z-index', '999995', 'important');
  currentIndex = index;

  try {
    const pill = getOrCreateLiquidPill();
    const rect = el.getBoundingClientRect();

    // Add padding around word for visual comfort
    const padX = 3;
    const padY = 2;
    const targetX = Math.round(rect.left - padX);
    const targetY = Math.round(rect.top - padY);
    const targetW = Math.max(8, Math.round(rect.width + padX * 2));
    const targetH = Math.max(14, Math.round(rect.height + padY * 2));

    const isLineBreak = lastTop !== null && Math.abs(targetY - lastTop) > 8;

    if (isLineBreak || lastTop === null) {
      // Snap instantly when crossing a line — never animate diagonally
      pill.style.setProperty('transition', 'none', 'important');
      pill.style.setProperty('transform', `translate3d(${targetX}px, ${targetY}px, 0)`, 'important');
      pill.style.setProperty('width', `${targetW}px`, 'important');
      pill.style.setProperty('height', `${targetH}px`, 'important');
      pill.style.setProperty('opacity', '1', 'important');
      // Force reflow so the no-transition snap actually applies
      void pill.offsetWidth;
      pill.style.removeProperty('transition');
    } else {
      // Smooth liquid slide within the same line
      pill.style.setProperty('transform', `translate3d(${targetX}px, ${targetY}px, 0)`, 'important');
      pill.style.setProperty('width', `${targetW}px`, 'important');
      pill.style.setProperty('height', `${targetH}px`, 'important');
      pill.style.setProperty('opacity', '1', 'important');
    }
    lastTop = targetY;

    // Auto-scroll when word goes out of view
    const inView =
      rect.top >= 20 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) - 20;
    if (!inView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch {
    // Ignore layout errors on pages with unusual DOM structure
  }
}

/** Repositions the pill when the page scrolls (since pill is position:fixed, it stays in viewport) */
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
    const padX = 3;
    const padY = 2;
    const targetX = Math.round(rect.left - padX);
    const targetY = Math.round(rect.top - padY);
    const targetW = Math.max(8, Math.round(rect.width + padX * 2));
    const targetH = Math.max(14, Math.round(rect.height + padY * 2));
    // Instant reposition on scroll — no transition
    pill.style.setProperty('transition', 'none', 'important');
    pill.style.setProperty('transform', `translate3d(${targetX}px, ${targetY}px, 0)`, 'important');
    pill.style.setProperty('width', `${targetW}px`, 'important');
    pill.style.setProperty('height', `${targetH}px`, 'important');
    lastTop = targetY;
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

/**
 * Highlights a word by index.
 */
function highlightWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  paintWord(spans, index);
}

/**
 * Translates a spoken word index into the source word it came from.
 */
function sourceIndexFor(state: ContentState, spokenIndex: number): number | undefined {
  if (state.spokenToSource.length === 0) return spokenIndex;
  return state.spokenToSource[spokenIndex];
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
 */
function wrapTextNode(node: Text, start: number, end: number, spans: HTMLElement[], injected: HTMLElement[]): void {
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

/** Wraps every word of the range. Returns the word list and every injected span. */
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

/**
 * Undoes the wrapping so the page is left byte-for-byte as it was found.
 */
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
        prev.style.removeProperty('color');
        prev.style.removeProperty('position');
        prev.style.removeProperty('z-index');
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

    const style = document.getElementById(STYLE_ID);
    if (style?.parentNode) style.parentNode.removeChild(style);
  };

  state.run = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    // Snapshot the range before any DOM mutation or cleanup
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
      // Ignore removal error
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
