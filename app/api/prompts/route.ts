import { route } from '@/lib/api';
import { listPrompts } from '@/lib/prompts/manage';

export const GET = route({}, async () => ({ prompts: await listPrompts() }));
