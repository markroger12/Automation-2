import { route } from '@/lib/api';
import { getPrompt, savePrompt, savePromptSchema } from '@/lib/prompts/manage';

export const GET = route({}, async ({ params }) => ({ prompt: await getPrompt(params.id) }));
export const PUT = route({ body: savePromptSchema }, async ({ params, body }) => savePrompt(params.id, body));
