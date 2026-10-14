import Papa from 'papaparse';
import { route } from '@/lib/api';
import { listTasks, taskListQuerySchema } from '@/lib/tasks/query';
import { moduleDisplayName, STATUS_LABELS, type TaskStatus } from '@/lib/domain';

/** CSV export of the filtered task list (draft links + SEO status). */
export const GET = route({}, async ({ searchParams }) => {
  const query = taskListQuerySchema.parse({ ...Object.fromEntries(searchParams.entries()), limit: 500, offset: 0 });
  const all: Awaited<ReturnType<typeof listTasks>>['rows'] = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await listTasks({ ...query, offset });
    all.push(...page.rows);
    if (page.rows.length < 500) break;
  }
  const csv = Papa.unparse(
    all.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      secondary_keywords: r.secondaryKeywords.join(', '),
      example_title: r.exampleTitle ?? '',
      selected_title: r.selectedTitle ?? '',
      writer: moduleDisplayName(r.moduleKey),
      website: r.websiteName,
      language: r.language,
      category: r.categoryName ?? '',
      status: STATUS_LABELS[r.status as TaskStatus] ?? r.status,
      seo_score: r.seoScore ?? '',
      rank_math_score: r.rankMathScore ?? 'not verified',
      wordpress_post_id: r.wpPostId ?? '',
      wordpress_edit_url: r.wpEditUrl ?? '',
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    })),
  );
  return new Response('﻿' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="articles-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
