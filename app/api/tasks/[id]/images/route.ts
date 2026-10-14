import { formFiles, formRoute } from '@/lib/api';
import { addOwnerImages, MAX_OWNER_UPLOADS } from '@/lib/tasks/images';

/** Owner photos for this article (max 12 MB each); used first on the next Images run. */
export const POST = formRoute({ maxBytes: MAX_OWNER_UPLOADS * 12 * 1024 * 1024 + 1024 * 1024 }, async ({ params, form }) => addOwnerImages(params.id, await formFiles(form, 'files', MAX_OWNER_UPLOADS)));
