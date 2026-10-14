import { z } from 'zod';
import { route } from '@/lib/api';
import { templateSchema } from '@/lib/image-template';
import { renderPreview } from '@/images/site-templates';

const schema = z.object({
  template: templateSchema.nullable(),
  kind: z.enum(['featured', 'body']),
  title: z.string().max(300).default(''),
  photoAssetIds: z.array(z.string().max(40)).max(2).optional(),
  logoAssetId: z.string().max(40).nullable().optional(),
  final: z.boolean().optional(),
});

/** Live preview through the production renderer (draft 960×540, or the site's final output with its byte budget). */
export const POST = route({ body: schema }, async ({ params, body }) => {
  const r = await renderPreview(params.id, body);
  return new Response(new Uint8Array(r.buffer), {
    headers: {
      'Content-Type': r.mime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Image-Width': String(r.width),
      'X-Image-Height': String(r.height),
      'X-Image-Bytes': String(r.bytes),
      ...(r.quality !== null ? { 'X-Image-Quality': String(r.quality) } : {}),
      ...(r.budget !== null ? { 'X-Image-Budget': String(r.budget) } : {}),
    },
  });
});
