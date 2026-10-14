import { PageHeader } from '@/components/ui';
import { HumanizerPage } from './humanizer';

export const metadata = { title: 'Humanizer' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <>
      <PageHeader
        title="Humanizer"
        description="Editorial polish with fact locks for a saved article or pasted text: clearer, more natural paragraphs that keep every fact, name, number, quote, link and the keyword count. Not a detector-bypass tool."
      />
      <HumanizerPage initialTaskId={sp.task} initialRunId={sp.run} />
    </>
  );
}
