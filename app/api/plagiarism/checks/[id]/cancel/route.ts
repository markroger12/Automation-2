import { route } from '@/lib/api';
import { cancelPlagiarismCheck } from '@/lib/plagiarism/service';

export const POST = route({}, async ({ params }) => cancelPlagiarismCheck(params.id));
