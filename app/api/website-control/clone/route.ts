import { route } from '@/lib/api';
import { cloneSchema, cloneSettings } from '@/lib/website-control';

/** Copy safe settings from one website to others (never URLs, profiles, categories or permissions; audited). */
export const POST = route({ body: cloneSchema }, async ({ body }) => cloneSettings(body));
