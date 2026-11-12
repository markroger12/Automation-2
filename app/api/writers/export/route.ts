import { route } from '@/lib/api';
import { exportWriters } from '@/lib/writers/transfer';

export const dynamic = 'force-dynamic';

/** Your writers as a file (?key=custom-… for one or more; none: all of them). Settings and prompts only. */
export const GET = route({}, async ({ searchParams }) => {
  const { file, filename } = await exportWriters(searchParams.getAll('key'));
  return new Response(`${JSON.stringify(file, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
  });
});
