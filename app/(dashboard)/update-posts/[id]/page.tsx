import { PostUpdateView } from './view';

export const metadata = { title: 'Update to Latest' };
export const dynamic = 'force-dynamic';

export default async function PostUpdatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PostUpdateView id={id} />;
}
