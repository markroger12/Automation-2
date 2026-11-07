import { route } from '@/lib/api';
import { createCustomWriter, createWriterSchema, listCustomWriters } from '@/lib/writers/store';

export const dynamic = 'force-dynamic';

/** Your writers (Writers page). */
export const GET = route({}, async () => ({ writers: await listCustomWriters() }));
/** A new writer (a draft), started from a built-in writer, an empty one, or one of yours. */
export const POST = route({ body: createWriterSchema }, async ({ body }) => ({ writer: await createCustomWriter(body) }));
