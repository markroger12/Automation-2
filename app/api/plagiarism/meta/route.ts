import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { plagiarismMeta } from '@/lib/plagiarism/service';

/** What the Plagiarism Evidence page needs: whether a search service is configured, limits, and articles with text. */
export const GET = route({}, async ({ searchParams }) => {
  const q = searchParams.get('q')?.trim();
  const [settings, articles] = await Promise.all([
    getSettings(),
    db.articleTask.findMany({
      where: { OR: [{ assembledHtml: { not: null } }, { editedHtml: { not: null } }, { bodyHtml: { not: null } }], ...(q ? { keyword: { contains: q } } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, keyword: true, selectedTitle: true, language: true, status: true, updatedAt: true, website: { select: { name: true } } },
    }),
  ]);
  return { ...plagiarismMeta(), defaultLanguage: settings.content.defaultLanguage, articles };
});
