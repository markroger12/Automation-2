import sanitizeHtml from 'sanitize-html';

/**
 * Allow-listed article HTML. Applied before saving model output and again
 * before display. Scripts, styles, event handlers, iframes and javascript:
 * URLs never survive.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'figure', 'figcaption', 'img', 'blockquote', 'br', 'hr', 'span', 'code', 'sup', 'sub',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target', 'data-bas-link'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'data-bas-media', 'class'],
    figure: ['class', 'data-bas-slot'],
    th: ['scope', 'colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    table: ['class'],
    p: ['class', 'data-bas-internal-link'],
    span: ['class'],
  },
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
