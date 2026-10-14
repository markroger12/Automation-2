import { z } from 'zod';
import { route } from '@/lib/api';
import { deleteTemplate, listTemplates, saveTemplate } from '@/lib/campaigns/service';

export const GET = route({}, async () => ({ templates: await listTemplates() }));
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => saveTemplate(body));
export const DELETE = route({}, async ({ searchParams }) => deleteTemplate(searchParams.get('name') ?? ''));
