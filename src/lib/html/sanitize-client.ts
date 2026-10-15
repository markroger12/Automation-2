import DOMPurify from 'dompurify';
import { ARTICLE_ATTRIBUTES, ARTICLE_TAGS } from './allowlist';

/**
 * Browser-side display sanitizing for HTML the owner is editing (unsaved
 * text, pasted HTML, a restored local draft): the same allow-list as the
 * server, so nothing in an edit can run script while it is shown. Saving
 * still sanitizes on the server.
 */
const ATTRS = [...new Set(Object.values(ARTICLE_ATTRIBUTES).flat())];

export function sanitizeForDisplay(html: string): string {
  if (typeof window === 'undefined' || !html) return '';
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ARTICLE_TAGS, ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false });
}

/** Parse HTML without running it: a DOMParser document never executes scripts or loads images. */
export function inertBody(html: string): HTMLElement | null {
  if (typeof DOMParser === 'undefined') return null;
  return new DOMParser().parseFromString(html, 'text/html').body;
}
