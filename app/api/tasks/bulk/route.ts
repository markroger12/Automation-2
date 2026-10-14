import { z } from 'zod';
import { route } from '@/lib/api';
import { requestCancel, retryTask } from '@/lib/tasks/lifecycle';
import { errorMessage } from '@/lib/log';

const schema = z.object({ ids: z.array(z.string().min(1).max(40)).min(1).max(1000), action: z.enum(['cancel', 'retry']) });

/** Bulk queue actions. Each task is handled independently; failures are reported per task. */
export const POST = route({ body: schema }, async ({ body }) => {
  const results: { id: string; ok: boolean; message?: string }[] = [];
  for (const id of body.ids) {
    try {
      if (body.action === 'cancel') await requestCancel(id);
      else await retryTask(id);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, message: errorMessage(error) });
    }
  }
  return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
});
