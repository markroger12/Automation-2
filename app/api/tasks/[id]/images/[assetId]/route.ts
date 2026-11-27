import { z } from 'zod';
import { route } from '@/lib/api';
import { IMAGE_PLACES, removeTaskImage, setTaskImagePlace } from '@/lib/tasks/images';

/** Exclude a source photo from this article (kept on disk). */
export const DELETE = route({}, async ({ params }) => removeTaskImage(params.id, params.assetId));

/** Use this source photo in the featured image or a body image (null: the app chooses). */
export const PATCH = route({ body: z.object({ place: z.enum(IMAGE_PLACES).nullable() }) }, async ({ params, body }) => setTaskImagePlace(params.id, params.assetId, body.place));
