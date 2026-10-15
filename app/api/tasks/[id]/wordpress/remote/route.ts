import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { parseJson } from '@/lib/json';
import { compareVersions } from '@/wordpress/compare';

type RemoteEdit = { postId: number; modifiedGmt: string; content: string; capturedAt: string };

/**
 * The WordPress version captured when a draft was found edited in WordPress,
 * compared with the app's version (what “Overwrite WordPress draft” would replace).
 * Read from the stored capture: no browser is opened.
 */
export const GET = route({}, async ({ params }) => {
  const task = await db.articleTask.findUnique({ where: { id: params.id }, select: { id: true, editedHtml: true, assembledHtml: true, stages: { where: { kind: 'wordpress' }, select: { key: true, privateState: true } } } });
  if (!task) throw notFound('Task');
  const captures = task.stages.map((s) => ({ stage: s.key, edit: parseJson<{ remoteEdit?: RemoteEdit | null }>(s.privateState, {}).remoteEdit })).filter((c): c is { stage: string; edit: RemoteEdit } => !!c.edit?.content);
  const latest = captures.sort((a, b) => b.edit.capturedAt.localeCompare(a.edit.capturedAt))[0];
  if (!latest) return { remote: null };
  const comparison = compareVersions(task.editedHtml ?? task.assembledHtml ?? '', latest.edit.content);
  return { remote: { postId: latest.edit.postId, modifiedGmt: latest.edit.modifiedGmt, capturedAt: latest.edit.capturedAt, stage: latest.stage }, ...comparison };
});
