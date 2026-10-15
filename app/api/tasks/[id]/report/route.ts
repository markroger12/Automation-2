import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { articleReport, articleReportFilename } from '@/lib/tasks/report';

/** One article's full report (stages, prompts, answers, checks, logs) as a JSON download, for support. */
export const GET = route({}, async ({ params }) => {
  const task = await db.articleTask.findUnique({ where: { id: params.id }, select: { id: true, slug: true, keyword: true } });
  if (!task) throw notFound('Task');
  const report = await articleReport(task.id);
  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${articleReportFilename(task)}"`, 'Cache-Control': 'no-store' },
  });
});
