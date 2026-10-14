import { route } from '@/lib/api';
import { approveArticle } from '@/lib/tasks/actions';

export const POST = route({}, async ({ params }) => approveArticle(params.id));
