import { formFiles, formRoute } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import { storeTemplateAsset, TEMPLATE_ASSET_ROLES, type TemplateAssetRole } from '@/images/site-templates';

/** Upload a site logo (PNG/JPEG/WebP/GIF or sanitized SVG) or a fixed template photo. */
export const POST = formRoute({ maxBytes: 13 * 1024 * 1024 }, async ({ params, form }) => {
  const role = String(form.get('role') ?? '');
  if (!(TEMPLATE_ASSET_ROLES as readonly string[]).includes(role)) throw badRequest('role must be LOGO or TEMPLATE_PHOTO.');
  const [file] = await formFiles(form, 'file', 1);
  if (!file) throw badRequest('Choose an image file.');
  const asset = await storeTemplateAsset(params.id, role as TemplateAssetRole, file);
  return { asset: { id: asset.id, role: asset.role, width: asset.width, height: asset.height, name: asset.notes ?? '' } };
});
