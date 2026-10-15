import { PageHeader } from '@/components/ui';
import { DuplicateReview } from './duplicates';

export const metadata = { title: 'Duplicate Review' };

export default function DuplicatesPage() {
  return (
    <>
      <PageHeader
        title="Duplicate Review"
        description="Articles whose wording overlaps another saved article on any of your websites. Shared facts (names, dates, numbers) are shown separately and never count as duplication. Nothing is deleted or rewritten automatically."
      />
      <DuplicateReview />
    </>
  );
}
