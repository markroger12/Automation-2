import { z } from 'zod';
import { route } from '@/lib/api';
import { clearDecision, decideClaim } from '@/lib/research/service';

/** The owner's decision on a claim (accepted / omitted / corrected), audited; the evidence stays. */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => ({ claim: await decideClaim(params.claimId, body) }));
export const DELETE = route({}, async ({ params }) => clearDecision(params.claimId));
