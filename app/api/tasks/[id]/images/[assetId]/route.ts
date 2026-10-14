import { route } from '@/lib/api';
import { removeTaskImage } from '@/lib/tasks/images';

/** Exclude a source photo from this article (kept on disk). */
export const DELETE = route({}, async ({ params }) => removeTaskImage(params.id, params.assetId));
