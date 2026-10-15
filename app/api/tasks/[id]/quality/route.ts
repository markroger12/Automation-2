import { route } from '@/lib/api';
import { latestQualityReport } from '@/lib/quality/report';
import { duplicatesForTask } from '@/lib/duplicates/service';

/** The latest ArticleQualityReport of a task and its duplicate overlaps. */
export const GET = route({}, async ({ params }) => ({ report: await latestQualityReport(params.id), duplicates: await duplicatesForTask(params.id) }));
