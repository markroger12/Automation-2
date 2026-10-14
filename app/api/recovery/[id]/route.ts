import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { resumeTask, retryTask } from '@/lib/tasks/lifecycle';

const schema = z.object({
  action: z.enum(['resolve', 'dismiss', 'resume-task', 'retry-task']),
  note: z.string().max(1000).optional(),
});

/** Manual reconciliation of a recovery incident. Never deletes content. */
export const POST = route({ body: schema }, async ({ params, body }) => {
  const incident = await db.recoveryIncident.findUnique({ where: { id: params.id } });
  if (!incident) throw notFound('Incident');
  if (body.action === 'resume-task' || body.action === 'retry-task') {
    if (!incident.taskId) throw notFound('Task for this incident');
    if (body.action === 'resume-task') await resumeTask(incident.taskId, 'recovery-center');
    else await retryTask(incident.taskId);
  }
  const status = body.action === 'dismiss' ? 'DISMISSED' : 'RESOLVED';
  await db.recoveryIncident.update({
    where: { id: incident.id },
    data: { status, resolvedAt: new Date(), resolution: body.note ?? `${body.action} from Recovery Center` },
  });
  await audit(`recovery.${body.action}`, 'RecoveryIncident', incident.id, { taskId: incident.taskId, note: body.note });
  return { ok: true, status };
});
