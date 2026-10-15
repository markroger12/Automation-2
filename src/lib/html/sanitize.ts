import sanitizeHtml from 'sanitize-html';
import { ARTICLE_ATTRIBUTES, ARTICLE_TAGS } from './allowlist';

/**
 * Allow-listed article HTML. Applied before saving model output and again
 * before display. Scripts, styles, event handlers, iframes and javascript:
 * URLs never survive.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ARTICLE_TAGS,
  allowedAttributes: ARTICLE_ATTRIBUTES,
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href ?? '';
      const external = /^https?:\/\//i.test(href);
      return { tagName, attribs: external ? { ...attribs, rel: attribs.rel ?? 'noopener' } : attribs };
    },
    b: 'strong',
    i: 'em',
  },
};

export function sanitizeArticleHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html, OPTIONS).trim();
}
