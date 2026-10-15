import { route } from '@/lib/api';
import { websiteGrid } from '@/lib/website-control';

export const GET = route({}, async () => ({ websites: await websiteGrid() }));
