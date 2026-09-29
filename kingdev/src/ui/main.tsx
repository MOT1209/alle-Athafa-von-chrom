/**
 * Panel bundle entry (plan Phase 1).
 *
 * Mounts the React app into `#root` inside `panel.html`. Kept deliberately
 * thin: everything testable lives in `app.tsx` / `rpc.ts`, this file only owns
 * the DOM mount, which the vitest node environment cannot cover.
 */

import { createRoot } from 'react-dom/client';
import { PanelApp } from './app';

const container = document.getElementById('root');

if (container) {
  createRoot(container).render(<PanelApp />);
} else {
  // panel.html is broken or was rebuilt without #root — say so loudly rather
  // than shipping a blank panel.
  document.body.textContent = 'KingDev panel failed to mount: #root element missing.';
}
