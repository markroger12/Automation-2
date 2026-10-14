import { NotBuilt } from '@/components/not-built';

export const metadata = { title: 'Article History' };

export default function HistoryPage() {
  return <NotBuilt title={'Article History'} milestone={'M5'} description={'Searchable history of every article with SEO and WordPress links.'} />;
}
