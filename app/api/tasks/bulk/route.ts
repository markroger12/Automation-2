import { z } from 'zod';
import { route } from '@/lib/api';
import { requestCancel, retryTask } from '@/lib/tasks/lifecycle';
import { approveWaiting } from '@/lib/tasks/actions';
import { deleteTask } from '@/lib/tasks/delete';
import { errorMessage } from '@/lib/log';

// `reason` is needed only to approve a task that needs review (it is audited); without it such a task is skipped.
const schema = z.object({ ids: z.array(z.string().min(1).max(40)).min(1).max(1000), action: z.enum(['cancel', 'retry', 'approve', 'delete']), reason: z.string().trim().max(500).optional() });

/** Bulk queue actions. Each task is handled independently; failures are reported per task. */
export const POST = route({ body: schema }, async ({ body }) => {
  const results: { id: string; ok: boolean; message?: string }[] = [];
  for (const id of body.ids) {
    try {
      if (body.action === 'cancel') await requestCancel(id);
      else if (body.action === 'approve') await approveWaiting(id, body.reason ?? '');
      else if (body.action === 'delete') await deleteTask(id);
      else await retryTask(id);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, message: errorMessage(error) });
    }
  }
  return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
});
