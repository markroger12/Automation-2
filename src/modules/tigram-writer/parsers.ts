import { makeSlug } from '@/lib/content/text';

export interface TigramArticleParse {
  seoTitle: string | null;
  metaDescription: string | null;
  slug: string | null;
  body: string;
  problems: string[];
  warnings: string[];
}

/**
 * Parse the ARTICLE answer: three machine-readable lines first
 * (SEO TITLE / META DESCRIPTION / URL SLUG), then the Markdown article.
 */
export function parseTigramArticle(text: string, language: string): TigramArticleParse {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const problems: string[] = [];
  const warnings: string[] = [];
  let seoTitle: string | null = null;
  let meta: string | null = null;
  let slug: string | null = null;
  let i = 0;
  for (; i < Math.min(lines.length, 12); i++) {
    const line = lines[i].replace(/^\*\*|\*\*$/g, '').trim();
    if (!line) continue;
    const m = line.match(/^\**\s*(SEO[- ]?TITLE|SEO[- ]?TITEL|META[- ]?DESCRIPTION|META[- ]?BESCHREIBUNG|URL[- ]?SLUG|SLUG)\s*\**\s*:\s*(.+)$/i);
    if (!m) {
      if (seoTitle && meta && slug) break;
      if (/^#{1,6}\s|^[A-ZÄÖÜ]/.test(line) && (seoTitle || meta || slug)) break;
      continue;
    }
    const value = m[2].replace(/^["“„]|["”“]$/g, '').replace(/\*\*/g, '').trim();
    const key = m[1].toUpperCase().replace(/[- ]/g, '');
    if (key.startsWith('SEOTIT')) seoTitle = value;
    else if (key.startsWith('META')) meta = value;
    else slug = value;
  }
  if (!seoTitle) problems.push('SEO TITLE line missing.');
  if (!meta) problems.push('META DESCRIPTION line missing.');
  if (!slug) problems.push('URL SLUG line missing.');
  const body = lines.slice(i).join('\n').trim();
  if (body.length < 200) problems.push('Article body missing after the metadata lines.');
  const cleanSlug = slug ? makeSlug(slug.replace(/^\/+|\/+$/g, '').split('/').pop() ?? slug, language, 12) : null;
  if (seoTitle && seoTitle.length > 60) warnings.push(`SEO title has ${seoTitle.length} characters (under 60 preferred).`);
  if (meta && (meta.length < 100 || meta.length > 150)) warnings.push(`Meta description has ${meta.length} characters (100–150 requested).`);
  if (slug && cleanSlug !== slug) warnings.push(`Slug normalized from “${slug}” to “${cleanSlug}”.`);
  return { seoTitle, metaDescription: meta, slug: cleanSlug, body, problems, warnings };
}

/** Parse "CATEGORY: <exact name>" and match it to an existing category (exact, case-insensitive). */
export function matchCategory(text: string, categories: { id: string; name: string }[]): { id: string; name: string } | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^\**\s*(category|kategorie)\s*\**\s*:/i.test(l));
  const raw = (line ? line.replace(/^\**\s*(category|kategorie)\s*\**\s*:\s*/i, '') : text.trim().split('\n')[0] ?? '').replace(/^["“„*]+|["”“*.]+$/g, '').trim();
  if (!raw) return null;
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return categories.find((c) => norm(c.name) === norm(raw)) ?? null;
}
