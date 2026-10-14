import { NotBuilt } from '@/components/not-built';

export const metadata = { title: 'Article Queue' };

export default function QueuePage() {
  return <NotBuilt title={'Article Queue'} milestone={'M2/M5'} description={'Live progress, stages, worker ownership, retries and actions.'} />;
}
