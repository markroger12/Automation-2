import { route } from '@/lib/api';
import { controlsSchema, updateSiteControls } from '@/lib/website-control';

/** Pause/resume, priority and the per-site limit of articles in progress (audited). */
export const PATCH = route({ body: controlsSchema }, async ({ params, body }) => updateSiteControls(params.id, body));
