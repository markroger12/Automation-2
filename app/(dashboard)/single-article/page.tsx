import { NotBuilt } from '@/components/not-built';

export const metadata = { title: 'Single Article' };

export default function SingleArticlePage() {
  return <NotBuilt title={'Single Article'} milestone={'M5'} description={'Write one article from a primary keyword, secondary keywords and an example title.'} />;
}
