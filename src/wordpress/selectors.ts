/**
 * Versioned WordPress selectors with prioritized fallbacks. Owner overrides
 * (Settings → Advanced → selectorOverrides) are tried first. Supports English
 * and German admin interfaces.
 */
export const SELECTORS_VERSION = '2026.10.14-1';

export const SELECTORS = {
  loggedIn: ['#wpadminbar', 'body.wp-admin', '#adminmenu'],
  loginForm: ['#loginform', 'form[name="loginform"]', 'input#user_login'],
  gutenbergRoot: ['body.block-editor-page', '.block-editor', '.edit-post-layout', '.editor-editor-interface'],
  classicEditor: ['#postdivrich', '#wp-content-wrap', 'textarea#content'],
  classicPublishBox: ['#submitdiv', '#publishing-action'],
  /** Host/plugin overlays that may cover the editor. Only these elements are hidden — never <html>/<body>. */
  hostOverlays: [
    '#hostinger-onboarding-overlay',
    '.hostinger-onboarding',
    '.hts-onboarding-overlay',
    '#hostinger-preview-banner',
    '.hostinger-notice-overlay',
    '.edit-post-welcome-guide',
    '.editor-welcome-guide',
  ],
  welcomeGuideClose: [
    '.edit-post-welcome-guide button[aria-label="Close"]',
    '.edit-post-welcome-guide button[aria-label="Schließen"]',
    '.components-modal__header button[aria-label="Close"]',
    '.components-modal__header button[aria-label="Schließen"]',
  ],
  categoryRows: ['#the-list tr[id^="tag-"]'],
  categoryRowName: ['a.row-title', '.row-title'],
  categoryRowSlug: ['td.slug', 'td.column-slug'],
  categoryRowCount: ['td.posts', 'td.column-posts'],
  rankMathScore: [
    '.rank-math-toolbar-score .rank-math-score',
    '.rank-math-toolbar-score',
    '.rank-math-seo-score .score-text',
    '#rank-math-metabox-wrapper .rank-math-score',
    '.rank-math-score',
  ],
  rankMathTabTrigger: ['button[aria-label="Rank Math"]', 'button.rank-math-toolbar-score', '.rank-math-toolbar-score'],
  rankMathRecommendations: ['.rank-math-checklist li', '.rank-math-tab-content-checks li', '#rank-math-metabox-wrapper .seo-check'],
} as const satisfies Record<string, readonly string[]>;

export type SelectorKey = keyof typeof SELECTORS;

export function selectorsFor(key: SelectorKey, overrides: Record<string, string[]> = {}): string[] {
  const custom = (overrides[key] ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 500);
  return [...custom, ...SELECTORS[key]];
}

/** A single combined CSS selector (comma list) for quick presence checks. */
export function anyOf(key: SelectorKey, overrides: Record<string, string[]> = {}): string {
  return selectorsFor(key, overrides).join(', ');
}
