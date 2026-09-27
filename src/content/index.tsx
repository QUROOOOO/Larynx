// Content Script — Injected on-demand via activeTab + chrome.scripting.executeScript
// Bundled as a self-contained IIFE (classic script, no ES module imports).
// Safe to inject multiple times: persistent state lives on window, setup runs once.

import { createPillAction } from '../shared/messaging';
import type { PillAction } from '../shared/types';
import { PillUI } from '../pill/PillUI';
import { createRoot, type Root } from 'react-dom/client';
import pillCss from '../pill/pill.css?inline';

interface PillProps {
  currentSentence?: string;
  sentenceIndex?: number;
  isPlaying: boolean;
  rate: number;
}

interface LarynxContentState {
  root: Root | null;
  host: HTMLElement | null;
  lastRect: DOMRect | null;
  pillProps: PillProps;
  run: () => void;
  render: () => void;
  cleanup: () => void;
}

declare global {
  interface Window {
    __larynx?: LarynxContentState;
    larynxCleanup?: () => void;
  }
}

function getSelectionData(): { text: string; rect: DOMRect } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return null;

  return { text, rect: range.getBoundingClientRect() };
}

const EMPTY_RECT = {
  left: 0, top: 0, width: 0, height: 0,
  bottom: 0, right: 0, x: 0, y: 0,
} as unknown as DOMRect;

function sendSelection(data: { text: string; rect: DOMRect }) {
  chrome.runtime.sendMessage({ type: 'SELECTION', payload: data });
}

if (!window.__larynx) {
  const state: LarynxContentState = {
    root: null,
    host: null,
    lastRect: null,
    pillProps: { isPlaying: false, rate: 1.0 },
    run: () => {},
    render: () => {},
    cleanup: () => {},
  };
  window.__larynx = state;

  const handleAction = (action: string) => {
    chrome.runtime.sendMessage(createPillAction(action as PillAction['action']));
  };

  state.render = () => {
    if (!state.root || !state.lastRect) return;
    state.root.render(
      <PillUI
        initialRect={state.lastRect}
        onAction={handleAction}
        currentSentence={state.pillProps.currentSentence}
        sentenceIndex={state.pillProps.sentenceIndex}
        isPlaying={state.pillProps.isPlaying}
        rate={state.pillProps.rate}
      />
    );
  };

  const ensurePill = (rect: DOMRect) => {
    state.lastRect = rect;
    if (state.root) {
      state.render();
      return;
    }

    const host = document.createElement('div');
    host.id = 'larynx-pill-root';
    host.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = pillCss;
    shadow.appendChild(style);

    const mountPoint = document.createElement('div');
    shadow.appendChild(mountPoint);
    (document.body || document.documentElement).appendChild(host);

    state.host = host;
    state.root = createRoot(mountPoint);
    state.render();
  };

  state.cleanup = () => {
    if (state.root) {
      state.root.unmount();
      state.root = null;
    }
    if (state.host) {
      state.host.remove();
      state.host = null;
    }
    state.lastRect = null;
    state.pillProps = { isPlaying: false, rate: 1.0 };
  };

  state.run = () => {
    const data = getSelectionData();
    if (data) {
      sendSelection(data);
      ensurePill(data.rect);
    } else {
      sendSelection({ text: '', rect: EMPTY_RECT });
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SENTENCE_PROGRESS') {
      state.pillProps.currentSentence = message.payload.sentenceText;
      state.pillProps.sentenceIndex = message.payload.sentenceIndex;
      state.pillProps.isPlaying = true;
      state.render();
      sendResponse({ success: true });
      return false;
    }
    if (message.type === 'PILL_STATE') {
      Object.assign(state.pillProps, message.payload);
      state.render();
      sendResponse({ success: true });
      return false;
    }
    if (message.type === 'HIDE_PILL') {
      state.cleanup();
      sendResponse({ success: true });
      return false;
    }
    return undefined;
  });

  window.larynxCleanup = state.cleanup;
  state.run();
} else {
  // Re-injection: state + listener already exist, just re-run selection logic
  window.__larynx.run();
}
