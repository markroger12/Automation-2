import { notFound } from 'next/navigation';
import { getTaskDetail, serializeDetail } from '@/lib/tasks/detail';
import { ArticleDetailView } from './view';

export const metadata = { title: 'Article' };

export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const detail = await getTaskDetail(id);
  if (!detail) notFound();
  return <ArticleDetailView initial={serializeDetail(detail)} initialTab={sp.tab} />;
}
