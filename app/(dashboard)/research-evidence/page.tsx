import { PageHeader } from '@/components/ui';
import { ResearchEvidence } from './research';

export const metadata = { title: 'Research Evidence' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <>
      <PageHeader
        title="Research Evidence"
        description="The significant claims in each article's research (dates, family, money, awards…) and the sources that support or contradict them. Sources about a different person with the same name are never used."
      />
      <ResearchEvidence initialTaskId={sp.task} />
    </>
  );
}
