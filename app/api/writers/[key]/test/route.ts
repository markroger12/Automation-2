import { route } from '@/lib/api';
import { testCustomWriter, testWriterSchema } from '@/lib/writers/store';

/** Read a pasted ChatGPT answer as this writer would (nothing is sent to ChatGPT or WordPress). */
export const POST = route({ body: testWriterSchema }, async ({ params, body }) => testCustomWriter(params.key, body));
