import { route } from '@/lib/api';
import { requestUndo } from '@/lib/posts/service';

/** Undo an applied update: the post gets its text and title from before (only while nobody edited it since). */
export const POST = route({}, async ({ params }) => requestUndo(params.id));
