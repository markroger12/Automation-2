import { route } from '@/lib/api';
import { rerunSeo } from '@/lib/tasks/actions';

export const POST = route({}, async ({ params }) => rerunSeo(params.id));
