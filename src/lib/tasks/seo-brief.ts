import { db } from '@/lib/db';
import { AppError, notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { parseJson } from '@/lib/json';
import { isActiveModuleKey } from '@/lib/domain';
import { briefCoverage, defaultSeoBrief, parseSeoBrief, seoBriefSchema, type SeoBrief } from '@/lib/seo/intent';

/**
 * The article's editable SEO brief (upgrade 04). The suggestion comes from
 * the deterministic intent rules; the owner may change the intent, the
 * sections and the guidance. The brief guides the writing prompt and an
 * informational coverage check — it never makes the app add text by itself.
 */

async function load(taskId: string) {
  const task = await db.articleTask.findUnique({ where: { id: taskId } });
  if (!task) throw notFound('Article');
  return task;
}

function suggestion(task: { keyword: string; secondaryKeywords: string; moduleKey: string; language: string }): SeoBrief {
  return defaultSeoBrief({ keyword: task.keyword, secondary: parseJson<string[]>(task.secondaryKeywords, []), moduleKey: task.moduleKey, language: task.language });
}

export async function getSeoBrief(taskId: string) {
  const task = await load(taskId);
  const suggested = suggestion(task);
  const brief = parseSeoBrief(task.seoBrief) ?? suggested;
  const html = task.editedHtml ?? task.assembledHtml ?? '';
  return { brief, suggested, coverage: html ? briefCoverage(html, brief) : null };
}

export async function saveSeoBrief(taskId: string, raw: unknown) {
  const task = await load(taskId);
  if (task.legacy || !isActiveModuleKey(task.moduleKey)) throw new AppError(409, 'RETIRED_WRITER', 'Retired writer tasks are read-only.');
  // Blank lines in the section list are dropped, not refused.
  const input = raw && typeof raw === 'object' && Array.isArray((raw as { sections?: unknown }).sections) ? { ...raw, sections: ((raw as { sections: unknown[] }).sections).filter((x) => typeof x !== 'string' || x.trim() !== '') } : raw;
  const brief: SeoBrief = { ...seoBriefSchema.parse(input), editedByOwner: true };
  await db.articleTask.update({ where: { id: taskId }, data: { seoBrief: JSON.stringify(brief) } });
  await audit('task.seo-brief', 'ArticleTask', taskId, { intent: brief.intent, sections: brief.sections.length });
  return getSeoBrief(taskId);
}

export async function resetSeoBrief(taskId: string) {
  const task = await load(taskId);
  await db.articleTask.update({ where: { id: taskId }, data: { seoBrief: JSON.stringify(suggestion(task)) } });
  await audit('task.seo-brief.reset', 'ArticleTask', taskId, {});
  return getSeoBrief(taskId);
}
