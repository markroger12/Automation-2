import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { ensureCustomWriters, getCustomWriter, listCustomWriters } from '@/lib/writers/store';
import { WriterBuilder } from './builder';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Writer' };

export default async function WriterPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await ensureCustomWriters();
  const detail = await getCustomWriter(key).catch(() => null);
  if (!detail) notFound();
  const [categories, writers] = await Promise.all([db.category.findMany({ select: { name: true }, distinct: ['name'], orderBy: { name: 'asc' }, take: 300 }), listCustomWriters()]);
  return (
    <WriterBuilder
      initial={JSON.parse(JSON.stringify(detail))}
      categoryNames={categories.map((c) => c.name)}
      own={writers.filter((w) => w.key !== key && w.status !== 'ARCHIVED').map((w) => ({ id: w.key, title: `Copy of ${w.name}`, kind: w.base, text: 'Its prompts and rules copied.' }))}
    />
  );
}
