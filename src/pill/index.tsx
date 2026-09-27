// Pill entry point — mounted by content script via dynamic import
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PillUI } from './PillUI';

export function mountPill(root: HTMLElement, props: React.ComponentProps<typeof PillUI>) {
  const reactRoot = createRoot(root);
  reactRoot.render(<PillUI {...props} />);
  return reactRoot;
}
