import { route } from '@/lib/api';
import { instanceInfo } from '@/lib/instance';

/** Which tool answers on this port, and a fingerprint of its data folder (see src/lib/instance.ts). */
export const GET = route({}, async () => instanceInfo());
