import { route } from '@/lib/api';
import { appOrigin } from '@/lib/env';
import { showToast } from '@/lib/notify/windows';

/** Settings → Notifications → Send a test notification: shown right away by this computer's Windows. */
export const POST = route({}, async () =>
  showToast({ title: 'Test notification', body: 'Windows notifications work. Articles to review, a signed-out ChatGPT and finished campaigns appear like this.', url: `${appOrigin()}/settings` }),
);
