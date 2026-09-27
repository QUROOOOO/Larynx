// Content Script — Injected on-demand via activeTab + chrome.scripting.executeScript
// No persistent listeners, no selectionchange polling

import { createPillAction } from '../shared/messaging';

let pillMounted = false;
let pillRoot: HTMLElement | null = null;
let pillComponent: any = null;
let PillUIComponent: any = null;

function getSelectionData(): { text: string; rect: DOMRect } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return null;

  const rect = range.getBoundingClientRect();
  return { text, rect };
}

function sendSelectionToBackground(data: { text: string; rect: DOMRect }) {
  chrome.runtime.sendMessage({ type: 'SELECTION', payload: data });
}

async function loadPillUI() {
  if (PillUIComponent) return PillUIComponent;
  const mod = await import('../pill/PillUI');
  PillUIComponent = mod.PillUI;
  return PillUIComponent;
}

async function mountPill(rect: DOMRect) {
  if (pillMounted) return;

  pillRoot = document.createElement('div');
  pillRoot.id = 'larynx-pill-root';
  pillRoot.style.cssText = `
    position: fixed;
    left: ${rect.left + rect.width / 2}px;
    top: ${rect.bottom + 8}px;
    z-index: 2147483647;
    pointer-events: none;
  `;
  document.body.appendChild(pillRoot);

  const PillUI = await loadPillUI();
  const { createRoot } = await import('react-dom/client');
  const React = await import('react');
  
  const root = createRoot(pillRoot!);
  root.render(React.createElement(PillUI, { initialRect: rect, onAction: handlePillAction }));
  pillComponent = root;
  pillMounted = true;
}

function handlePillAction(action: string) {
  chrome.runtime.sendMessage(createPillAction(action as any));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SENTENCE_PROGRESS') {
    // Use Promise to handle async rendering
    (async () => {
      if (message.payload.sentenceIndex !== undefined && pillComponent) {
        const PillUI = await loadPillUI();
        const React = await import('react');
        pillComponent.render(
          React.createElement(PillUI, { 
            initialRect: { left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 },
            onAction: handlePillAction,
            currentSentence: message.payload.sentenceText,
            sentenceIndex: message.payload.sentenceIndex
          })
        );
      }
    })();
  }
  sendResponse({ success: true });
  return true;
});

const selectionData = getSelectionData();
if (selectionData) {
  sendSelectionToBackground(selectionData);
  mountPill(selectionData.rect);
} else {
  chrome.runtime.sendMessage({ type: 'SELECTION', payload: { text: '', rect: { left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 } } });
}

export function cleanup() {
  if (pillComponent) {
    pillComponent.unmount();
    pillComponent = null;
  }
  if (pillRoot) {
    pillRoot.remove();
    pillRoot = null;
  }
  pillMounted = false;
}

(window as any).larynxCleanup = cleanup;
