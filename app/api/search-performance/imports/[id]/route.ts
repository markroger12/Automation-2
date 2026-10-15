import { route } from '@/lib/api';
import { deleteSearchSnapshot } from '@/lib/search-performance/service';

/** Remove one imported report (audited). */
export const DELETE = route({}, async ({ params }) => deleteSearchSnapshot(params.id));
