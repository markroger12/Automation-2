import { z } from 'zod';
import { route } from '@/lib/api';
import { requestImport } from '@/lib/posts/service';

/** Read the website's published posts into the app (the worker does it; nothing changes in WordPress). */
export const POST = route(
  { body: z.object({ websiteId: z.string().min(1).max(40), olderThanMonths: z.number().int().min(1).max(120).nullable(), categoryIds: z.array(z.number().int().positive()).max(50).default([]) }) },
  async ({ body }) => requestImport(body.websiteId, { olderThanMonths: body.olderThanMonths, categoryIds: body.categoryIds }),
);
