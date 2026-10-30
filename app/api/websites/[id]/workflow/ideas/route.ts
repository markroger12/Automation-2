import { z } from 'zod';
import { route } from '@/lib/api';
import { googleIdeas, searchConsoleIdeas } from '@/lib/workflow/keyword-ideas';

export const dynamic = 'force-dynamic';

/** Keyword ideas from Search Console: queries with impressions the website has no keyword or article for. */
export const GET = route({}, async ({ params }) => searchConsoleIdeas(params.id));

/** Keyword ideas from one Google search (Serper): related searches and “People also ask” for the seed. */
export const POST = route({ body: z.object({ seed: z.string().max(200) }) }, async ({ params, body }) => ({ ideas: await googleIdeas(params.id, body.seed) }));
