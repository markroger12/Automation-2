import { route } from '@/lib/api';
import { collectDiagnostics } from '@/lib/diagnostics';

/** Downloadable diagnostic bundle with secrets stripped. */
export const GET = route({}, async () => {
  const bundle = await collectDiagnostics();
  const name = `bas-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
  });
});
