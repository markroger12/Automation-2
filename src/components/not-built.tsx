import { Construction } from 'lucide-react';
import { Card, EmptyState, LinkButton, PageHeader } from './ui';

/**
 * Honest placeholder for modules that are not built yet in the current
 * milestone. It never shows fake data or inert controls.
 */
export function NotBuilt({ title, milestone, description }: { title: string; milestone: string; description: string }) {
  return (
    <>
      <PageHeader title={title} eyebrow="Coming soon" description={description} />
      <Card>
        <EmptyState
          icon={<Construction className="h-8 w-8" aria-hidden />}
          title={`Not built yet — planned for ${milestone}`}
          description="This page is intentionally empty until its milestone lands. See BUILD_STATUS.md for progress."
          action={<LinkButton href="/">Back to Overview</LinkButton>}
        />
      </Card>
    </>
  );
}
