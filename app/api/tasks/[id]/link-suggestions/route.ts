import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { parseJson } from '@/lib/json';

/** Internal-link targets the stage considered for this article, with why each was or was not used. */
export const GET = route({}, async ({ params }) => {
  const rows = await db.suggestedInternalLink.findMany({ where: { taskId: params.id }, orderBy: [{ kind: 'asc' }, { score: 'desc' }] });
  return { suggestions: rows.map((r) => ({ ...r, reasons: parseJson<string[]>(r.reasons, []) })) };
});
