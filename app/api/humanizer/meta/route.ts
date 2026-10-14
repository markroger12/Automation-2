import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { loadPromptTemplate } from '@/lib/prompts/load';
import { ACTIVE_MODULE_KEYS } from '@/lib/domain';

/** What the Humanizer page needs: the saved HUMANIZE prompt, settings, and articles with assembled text. */
export const GET = route({}, async ({ searchParams }) => {
  const q = searchParams.get('q')?.trim();
  const [settings, prompt, articles] = await Promise.all([
    getSettings(),
    loadPromptTemplate('shared', 'HUMANIZE'),
    db.articleTask.findMany({
      where: { legacy: false, moduleKey: { in: [...ACTIVE_MODULE_KEYS] }, OR: [{ assembledHtml: { not: null } }, { editedHtml: { not: null } }], ...(q ? { keyword: { contains: q } } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, keyword: true, selectedTitle: true, language: true, status: true, updatedAt: true, editedHtml: true, website: { select: { name: true } } },
    }),
  ]);
  return {
    prompt: { content: prompt.content, version: prompt.version },
    settings: { scope: settings.content.humanizerScope, batchWords: settings.content.humanizerBatchWords, tolerancePct: settings.content.humanizerLengthTolerancePct, defaultLanguage: settings.content.defaultLanguage },
    articles: articles.map(({ editedHtml, ...a }) => ({ ...a, edited: Boolean(editedHtml) })),
  };
});
