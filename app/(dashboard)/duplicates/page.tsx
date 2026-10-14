import { NotBuilt } from '@/components/not-built';

export const metadata = { title: 'Duplicate Review' };

export default function DuplicatesPage() {
  return <NotBuilt title={'Duplicate Review'} milestone={'M12'} description={'Cross-website similarity review.'} />;
}
