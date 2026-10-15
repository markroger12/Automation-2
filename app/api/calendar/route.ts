import { route } from '@/lib/api';
import { calendar } from '@/lib/workflow/service';

/** Reserved and free publishing slots of all workflows in a date range. */
export const GET = route({}, async ({ searchParams }) => calendar(searchParams.get('from') ?? new Date().toISOString(), Number(searchParams.get('days') ?? 14)));
