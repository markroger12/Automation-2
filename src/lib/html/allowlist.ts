/** The article HTML allow-list, shared by the server sanitizer (sanitize-html) and the browser one (DOMPurify). */
export const ARTICLE_TAGS = ['p', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'img', 'blockquote', 'br', 'hr', 'span', 'code', 'sup', 'sub'];

export const ARTICLE_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title', 'rel', 'target', 'data-bas-link'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'data-bas-media', 'class'],
  figure: ['class', 'data-bas-slot'],
  th: ['scope', 'colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  table: ['class'],
  p: ['class', 'data-bas-internal-link'],
  span: ['class'],
};
