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

/** Delay between two words while catching up across a gap. */
const CATCHUP_STEP_MS = 34;

/** Index of the word currently carrying the active class, or -1. */
let currentIndex = -1;

/** Pending catch-up step, if one is in flight. */
let catchUpTimer: ReturnType<typeof setTimeout> | null = null;

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
      /* A flat rectangle: no padding, no margin, never reflow the page. */
      padding: 0 !important;
      margin: 0 !important;
      border-radius: 0 !important;
      mix-blend-mode: normal !important;
      opacity: 1 !important;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .${WORD_CLASS}.${ACTIVE_CLASS} {
      background-color: #fff !important;
      mix-blend-mode: difference !important;
      opacity: 1 !important;
    }
    .${WORD_CLASS}::selection,
    .${GAP_CLASS}::selection {
      background-color: transparent !important;
      color: inherit !important;
    }`;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Paints exactly one word. The previous word is tracked by reference rather than
 * by re-scanning the list, so two words can never be highlighted at once.
 */
function paintWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  if (currentIndex >= 0 && currentIndex < spans.length && currentIndex !== index) {
    spans[currentIndex].classList.remove(ACTIVE_CLASS);
  }
  spans[index].classList.add(ACTIVE_CLASS);
  currentIndex = index;
}

/**
 * Advances the highlight to `index`.
 *
 * Progress arrives in order, so the common case is simply the next word. Three
 * edge cases are handled explicitly:
 *
 * - A repeat of the current index carries no new information, and an index
 *   *behind* the cursor is stale — a late `WORD_PROGRESS` from a sentence that
 *   finished after the reader had already moved on. Both are dropped rather than
 *   painted, because moving the highlight backwards reads as a glitch.
 * - An index that jumps ahead is walked one word at a time, so the reader still
 *   sees every word pass by and the highlight degrades into a fast catch-up
 *   instead of silently skipping text.
 */
function highlightWord(spans: HTMLElement[], index: number): void {
  if (index < 0 || index >= spans.length) return;
  if (index <= currentIndex) return;

  if (catchUpTimer !== null) {
    clearTimeout(catchUpTimer);
    catchUpTimer = null;
  }

  if (index === currentIndex + 1) {
    paintWord(spans, index);
    return;
  }

  const step = () => {
    const next = currentIndex + 1;
    paintWord(spans, next);
    if (next < index) {
      catchUpTimer = setTimeout(step, CATCHUP_STEP_MS);
    } else {
      catchUpTimer = null;
    }
  };
  step();
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

/** Wraps every word of the current selection. Returns the word list and every injected span. */
function wrapSelection(selection: Selection): { words: HTMLElement[]; injected: HTMLElement[] } {
  const spans: HTMLElement[] = [];
  const injected: HTMLElement[] = [];
  if (selection.rangeCount === 0) return { words: spans, injected };

  const range = selection.getRangeAt(0);
  const nodes = collectTextNodes(range);

  nodes.forEach((node) => {
    // Live ranges re-index as the DOM changes underneath them, so snapshot offsets first.
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (end > start) {
      wrapTextNode(node, start, end, spans, injected);
    }
  });

  return { words: spans, injected };
}

/**
 * Undoes the wrapping so the page is left byte-for-byte as it was found.
 *
 * The separators between words are elements in their own right, so the list
 * handed in here covers both the word spans and the gap spans. Each one simply
 * becomes a plain text node again — no separator is synthesised, because
 * inserting one would change the rendered text of the host page.
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
    injected: [],
    spokenToSource: [],
    lastText: '',
    run: () => {},
    cleanup: () => {},
  };

  window.__larynx = state;

  state.cleanup = () => {
    if (catchUpTimer !== null) {
      clearTimeout(catchUpTimer);
      catchUpTimer = null;
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

    // The original text is what gets remembered, so pressing the shortcut twice
    // re-derives an identical plan rather than compounding the first rewrite.
    const activeText = text || state.lastText;
    state.lastText = activeText;

    // The engine reads the cleaned-up plan; the page keeps showing the original
    // selection, and `spokenToSource` is the only thing tying the two together.
    const plan = prepareSpeech(activeText);
    state.spokenToSource = plan.spokenToSource;

    if (text) {
      ensureStyles();
      const wrapped = wrapSelection(selection!);
      state.wordSpans = wrapped.words;
      state.injected = wrapped.injected;

      // The range has been read and the words are now our own elements, so the
      // browser's own selection is pure noise: the UA paints it *over* the
      // highlight, and because it stretches across the whole selection it is
      // what makes the gaps between words look selected. Dropping it leaves the
      // custom background as the only thing marking the passage being read.
      try {
        selection!.removeAllRanges();
      } catch {
        // A selection can be torn down by the page between wrap and clear; the
        // wrap already succeeded, so there is nothing left to recover.
      }
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
