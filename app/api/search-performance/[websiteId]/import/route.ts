import { formFiles, formRoute } from '@/lib/api';
import { importSearchExport } from '@/lib/search-performance/service';

/** Import a Search Console performance export (zip or CSV files; 30 MB per request). */
export const POST = formRoute({ maxBytes: 30 * 1024 * 1024 }, async ({ params, form }) => {
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  return importSearchExport(params.websiteId, await formFiles(form, 'files', 12), { start: field('start'), end: field('end') });
});
