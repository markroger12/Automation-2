import { makeSlug } from '@/lib/content/text';
import { extractMetaLines } from '@/lib/content/meta-lines';

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
 * (SEO TITLE / META DESCRIPTION / URL SLUG), then the Markdown article. A value may stand on its label's line or on
 * the next line (see `extractMetaLines`).
 */
export function parseTigramArticle(text: string, language: string): TigramArticleParse {
  const problems: string[] = [];
  const warnings: string[] = [];
  const meta = extractMetaLines(text);
  const { seoTitle, slug } = meta;
  const metaDescription = meta.metaDescription;
  if (!seoTitle) problems.push('SEO TITLE line missing.');
  if (!metaDescription) problems.push('META DESCRIPTION line missing.');
  if (!slug) problems.push('URL SLUG line missing.');
  const body = meta.body;
  if (body.length < 200) problems.push('Article body missing after the metadata lines.');
  const cleanSlug = slug ? makeSlug(slug.replace(/^\/+|\/+$/g, '').split('/').pop() ?? slug, language, 12) : null;
  if (seoTitle && seoTitle.length > 60) warnings.push(`SEO title has ${seoTitle.length} characters (under 60 preferred).`);
  if (metaDescription && (metaDescription.length < 100 || metaDescription.length > 150)) warnings.push(`Meta description has ${metaDescription.length} characters (100–150 requested).`);
  if (slug && cleanSlug !== slug) warnings.push(`Slug normalized from “${slug}” to “${cleanSlug}”.`);
  return { seoTitle, metaDescription, slug: cleanSlug, body, problems, warnings };
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
