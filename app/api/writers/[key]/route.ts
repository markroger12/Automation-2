import { route } from '@/lib/api';
import { deleteCustomWriter, getCustomWriter, updateCustomWriter, updateWriterSchema } from '@/lib/writers/store';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ params }) => getCustomWriter(params.key));
/** Save the writer's settings and prompts (a prompt change is a new version). */
export const PUT = route({ body: updateWriterSchema }, async ({ params, body }) => updateCustomWriter(params.key, body));
/** Only a writer no article used; otherwise archive it. */
export const DELETE = route({}, async ({ params }) => deleteCustomWriter(params.key));
