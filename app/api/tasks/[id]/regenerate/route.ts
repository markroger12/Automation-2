import { z } from 'zod';
import { route } from '@/lib/api';
import { regenerateStage, regenerationPreview } from '@/lib/tasks/actions';

const schema = z.object({ stageKey: z.string().min(2).max(40), preview: z.boolean().optional() });

export const POST = route({ body: schema }, async ({ params, body }) => (body.preview ? regenerationPreview(params.id, body.stageKey) : regenerateStage(params.id, body.stageKey)));
