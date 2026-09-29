// Content Script — Injected on-demand via activeTab + chrome.scripting.executeScript
// Bundled as a self-contained IIFE (classic script, no ES module imports).
// Captures the selection, wraps it in per-word spans, and highlights as speech progresses.
// Safe to inject multiple times: persistent state lives on window.

import { prepareSpeech } from '../shared/text-utils';
import type { ContentMessage } from '../shared/types';

const WORD_CLASS = 'larynx-word';
const GAP_CLASS = 'larynx-gap';
const ACTIVE_CLASS = 'larynx-word-active';
const STYLE_ID = 'larynx-word-styles';

/** Index of the word currently carrying the active class, or -1. */
let currentIndex = -1;

/**
 * Disarms the selection-guard listener installed while a highlight is up.
 * Guarded by the fact that only one run ever owns the page at a time.
 */
let selectionGuard: (() => void) | null = null;

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

/**
 * The extension's own stylesheet is only bundled into the options page, so the
 * highlight rules have to be injected into whichever host page is being read.
 *
 * At rest the spans are completely invisible. They have to be styled anyway —
 * they are real elements sitting in the middle of the host page's text — and
 * anything left behind shows up as a visible reflow artefact, so every property
 * that could paint is pinned to its no-op value. What survives is
 * `box-decoration-break`, which is inherited behaviour rather than decoration,
 * and the `::selection` override below.
 *
 * The highlight itself is a plain rectangle produced by a *negative colour*
 * blend: `mix-blend-mode: difference` against a white fill inverts whatever the
 * host page has painted underneath, glyphs included. That is what keeps the
 * current word readable on any background — a page that is already light turns
 * the block dark, a page that is already dark turns it light, and mid-tones keep
 * exactly the contrast they started with. Nothing about the block is themed, so
 * no host-page colour can hide it.
 *
 * Only the active word is ever painted, and it is always at `opacity: 1`. The
 * inversion is the whole signal: there is no dimmed "already read" state
 * competing with it, so the eye is never asked to weigh two levels of emphasis
 * at once.
 *
 * The separators between words are injected as `larynx-gap` spans rather than
 * left as bare text nodes, because `::selection` can only be neutralised on
 * elements. Without that, the whitespace between two highlighted words falls
 * outside every highlighted element and the browser paints it with the native
 * selection colour — which is exactly the "the spaces get selected" artefact.
 *
 * Host-page resets cannot interfere: the selectors are specific and the
 * declarations that matter carry `!important`.
 */
let isDarkTheme = false;

function detectTheme(node?: Node | null): boolean {
  // 1. Direct Text Color Luminance: The most reliable signal on the web.
  // Dark text (<0.45 lum) means the text is displayed over a light background.
  // Light text (>0.55 lum) means the text is displayed over a dark background.
  const el: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement || document.body);
  if (el) {
    const textColor = window.getComputedStyle(el).color;
    const match = textColor.match(/\d+/g);
    if (match && match.length >= 3) {
      const r = parseInt(match[0], 10);
      const g = parseInt(match[1], 10);
      const b = parseInt(match[2], 10);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum < 0.45) return false; // Light page
      if (lum > 0.55) return true;  // Dark page
    }
  }

  // 2. Traverse ancestor background colors
  let curr: HTMLElement | null = el;
  while (curr && curr !== document.documentElement) {
    const bg = window.getComputedStyle(curr).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      const match = bg.match(/\d+/g);
      if (match && match.length >= 3) {
        const r = parseInt(match[0], 10);
        const g = parseInt(match[1], 10);
        const b = parseInt(match[2], 10);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
      }
    }
    curr = curr.parentElement;
  }

  const bodyBg = window.getComputedStyle(document.body || document.documentElement).backgroundColor;
  const match = bodyBg.match(/\d+/g);
  if (match && match.length >= 3) {
    const r = parseInt(match[0], 10);
    const g = parseInt(match[1], 10);
    const b = parseInt(match[2], 10);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  }

  return false;
}

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
      transition: background-color 0.10s ease, color 0.10s ease, transform 0.12s cubic-bezier(0.2, 1.25, 0.4, 1) !important;
    }
    .${WORD_CLASS}.${ACTIVE_CLASS} {
      position: relative !important;
      z-index: 999995 !important;
      display: inline-block !important;
      animation: larynx-spring-pop 0.14s cubic-bezier(0.18, 1.25, 0.35, 1) both !important;
      will-change: transform !important;
    }
    @keyframes larynx-spring-pop {
      0% {
        transform: scale(0.94) translateY(1px);
      }
      60% {
        transform: scale(1.08) translateY(-0.5px);
      }
      100% {
        transform: scale(1.03) translateY(0);
      }
    }
    .${WORD_CLASS}::selection,
    .${GAP_CLASS}::selection {
      background-color: transparent !important;
      color: inherit !important;
    }`;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Paints active word with self-contained negative-color styling and smooth spring jiggle.
 * Guarantees text is NEVER white-on-white or black-on-black.
 */
function paintWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  if (currentIndex >= 0 && currentIndex < spans.length && currentIndex !== index) {
    const prev = spans[currentIndex];
    prev.classList.remove(ACTIVE_CLASS);
    prev.style.removeProperty('background-color');
    prev.style.removeProperty('color');
    prev.style.removeProperty('padding');
    prev.style.removeProperty('margin');
    prev.style.removeProperty('border-radius');
    prev.style.removeProperty('box-shadow');
    prev.style.removeProperty('position');
    prev.style.removeProperty('z-index');
  }

  const el = spans[index];
  if (!el) return;

  el.classList.add(ACTIVE_CLASS);

  // Exact negative color applied directly to el:
  // Light page (dark text): Solid Black badge with Solid White text
  // Dark page (light text): Solid White badge with Solid Black text
  if (isDarkTheme) {
    el.style.setProperty('background-color', '#FFFFFF', 'important');
    el.style.setProperty('color', '#000000', 'important');
    el.style.setProperty('box-shadow', '0 2px 8px rgba(255, 255, 255, 0.3)', 'important');
  } else {
    el.style.setProperty('background-color', '#000000', 'important');
    el.style.setProperty('color', '#FFFFFF', 'important');
    el.style.setProperty('box-shadow', '0 2px 8px rgba(0, 0, 0, 0.25)', 'important');
  }

  el.style.setProperty('padding', '2px 4px', 'important');
  el.style.setProperty('margin', '0 -1px', 'important');
  el.style.setProperty('border-radius', '4px', 'important');
  el.style.setProperty('position', 'relative', 'important');
  el.style.setProperty('z-index', '999995', 'important');
  currentIndex = index;

  try {
    const rect = el.getBoundingClientRect();
    const inView =
      rect.top >= 20 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) - 20;
    if (!inView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch {
    // Ignore layout errors
  }
}

/**
 * Direct word highlighting on progress.
 */
function highlightWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  paintWord(spans, index);
}

/**
 * Translates a spoken word index into the source word it came from.
 *
 * `spokenToSource` is empty before a plan exists, and an out-of-range lookup can
 * only happen if the engine ever disagrees with the plan about how many words it
 * produced — in which case there is no honest index to paint, so the update is
 * dropped instead of guessed at.
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
 *
 * Every character of the original slice is preserved verbatim: the text between
 * words (and any leading/trailing whitespace) is emitted as real text using the
 * exact original substring, never a normalised " ". Collapsing the separators
 * would visibly rewrite the host page's text once the spans are unwrapped.
 *
 * Separators that fall *inside* the selection are wrapped in `larynx-gap` spans
 * so they pick up the range background and the `::selection` override. The text
 * before the selection and after it stays as bare text nodes, because that part
 * of the node was never selected and must not be highlighted.
 */
function wrapTextNode(node: Text, start: number, end: number, spans: HTMLElement[], injected: HTMLElement[]): void {
  const parent = node.parentNode;
  if (!parent) return;

  const covered = node.data.slice(start, end);
  if (!covered.trim()) return;

  const fragment = document.createDocumentFragment();

  // Preserve any text before the selection started.
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

  // Walk the word matches and copy the gaps between them through untouched, so
  // each span holds exactly one word and the separators keep their original form.
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

  // Merge the adjacent text nodes that used to be one.
  parents.forEach((parent) => parent.normalize());
}

/**
 * Scrub native selections that spring back over the injected spans.
 */
function armSelectionGuard(state: ContentState): void {
  if (selectionGuard) return;

  const handler = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    try {
      const range = selection.getRangeAt(0);
      const touchesInjected = state.injected.some((span) => {
        try {
          return range.intersectsNode(span);
        } catch {
          return false;
        }
      });
      if (touchesInjected) selection.removeAllRanges();
    } catch {
      // A selection can be torn down mid-check; nothing to clear then.
    }
  };

  document.addEventListener('selectionchange', handler, true);
  selectionGuard = () => document.removeEventListener('selectionchange', handler, true);
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
    if (selectionGuard) {
      selectionGuard();
      selectionGuard = null;
    }
    if (currentIndex >= 0 && currentIndex < state.wordSpans.length) {
      const prev = state.wordSpans[currentIndex];
      if (prev) {
        prev.classList.remove(ACTIVE_CLASS);
        prev.style.removeProperty('background-color');
        prev.style.removeProperty('color');
        prev.style.removeProperty('padding');
        prev.style.removeProperty('margin');
        prev.style.removeProperty('border-radius');
        prev.style.removeProperty('box-shadow');
        prev.style.removeProperty('position');
        prev.style.removeProperty('z-index');
      }
    }
    currentIndex = -1;
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

    // Detect page theme for simple negative color inversion
    isDarkTheme = detectTheme(range.commonAncestorContainer);

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

    armSelectionGuard(state);

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
