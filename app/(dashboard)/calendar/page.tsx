import { PageHeader } from '@/components/ui';
import { PublishingCalendar } from './calendar';

export const metadata = { title: 'Publishing Calendar' };

export default function CalendarPage() {
  return (
    <>
      <PageHeader title="Publishing Calendar" description="Reserved and free publishing slots of every workflow, two weeks at a time. “Published” and “indexed” are shown only after they were verified." />
      <PublishingCalendar />
    </>
  );
}
