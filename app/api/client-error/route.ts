import { z } from 'zod';
import { route } from '@/lib/api';
import { log } from '@/lib/log';

/**
 * An error of the dashboard page, written to the app's log (src/lib/client/report-error.ts), so it reaches Logs /
 * Diagnostics, the log file and a diagnostic bundle. Secrets are redacted by log() as everywhere.
 */
export const POST = route(
  {
    body: z.object({
      where: z.string().max(80),
      message: z.string().max(500),
      stack: z.string().max(3000).default(''),
      path: z.string().max(200).default(''),
    }),
  },
  async ({ body }) => {
    await log({ level: 'error', category: 'dashboard', message: `Dashboard error in ${body.where} (${body.path}): ${body.message}`, details: { stack: body.stack } });
    return { ok: true };
  },
);
