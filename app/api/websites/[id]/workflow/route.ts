import { z } from 'zod';
import { route } from '@/lib/api';
import { saveWorkflow, workflowView } from '@/lib/workflow/service';

export const GET = route({}, async ({ params }) => workflowView(params.id));
export const PUT = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => ({ workflow: await saveWorkflow(params.id, body) }));
