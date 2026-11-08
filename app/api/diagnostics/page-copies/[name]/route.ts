import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { readPageCopy } from '@/lib/page-copies';

/** Download one page structure copy (Logs / Diagnostics → Page structure copies) to send to the developer. */
export const GET = route({}, async ({ params }) => {
  const body = readPageCopy(params.name ?? '');
  if (!body) throw new AppError(404, 'NOT_FOUND', 'No such page structure copy.');
  return new Response(new Uint8Array(body), {
    headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${params.name}"`, 'Cache-Control': 'no-store' },
  });
});
