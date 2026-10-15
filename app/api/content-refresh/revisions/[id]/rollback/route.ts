import { route } from '@/lib/api';
import { rollbackRevision } from '@/lib/refresh/service';

/** Propose restoring the text before an applied revision (approved like any other revision). */
export const POST = route({}, async ({ params }) => rollbackRevision(params.id));
