/**
 * DevTools entry point (plan Phase 1).
 *
 * Chrome loads this script when a DevTools window opens for any page. Its only
 * job is to create the KingDev panel; everything the panel does lives in the
 * React app in `src/ui` (Phase 1's `main.tsx`).
 *
 * Kept dependency-free on purpose: this file must never fail, because a broken
 * devtools page silently produces *no panel* and no error the user would see.
 */

const PANEL_TITLE = 'KingDev';
const PANEL_PAGE = 'panel.html';

const runtime = (
  globalThis as {
    chrome?: {
      devtools?: {
        panels?: {
          create(title: string, icon: string, page: string, callback?: () => void): unknown;
        };
      };
    };
  }
).chrome?.devtools;

if (runtime?.panels) {
  runtime.panels.create(PANEL_TITLE, '', PANEL_PAGE, () => {
    // Panel created. Chrome fires this when the user first opens the panel;
    // sizing, theming and data loading all belong to the panel page itself.
  });
}
