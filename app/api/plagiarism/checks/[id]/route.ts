import { route } from '@/lib/api';
import { getPlagiarismCheck } from '@/lib/plagiarism/service';

export const GET = route({}, async ({ params }) => ({ check: await getPlagiarismCheck(params.id) }));
