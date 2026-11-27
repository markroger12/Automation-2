import { z } from 'zod';
import { route } from '@/lib/api';
import { startUpdates } from '@/lib/posts/service';

/** “Update to latest” for one or more posts: each is read fresh, given to ChatGPT, checked, and waits for approval. */
export const POST = route({ body: z.object({ sitePostIds: z.array(z.string().min(1).max(40)).min(1).max(50) }) }, async ({ body }) => startUpdates(body.sitePostIds));
