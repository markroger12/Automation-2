import { route } from '@/lib/api';
import { importWriters, importWritersSchema } from '@/lib/writers/transfer';

export const dynamic = 'force-dynamic';

/** Read a writer file (preview: true shows what would happen), then add its writers as drafts or update the same ones. */
export const POST = route({ body: importWritersSchema }, async ({ body }) => importWriters(body));
