import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

let client: PrismaClient;
let q: typeof import('@/lib/queue');

beforeAll(async () => {
  ({ client } = await setupTestDb());
  q = await import('@/lib/queue');
});

describe('database-backed queue', () => {
  it('enqueue is idempotent by key', async () => {
    const a = await q.enqueue({ queue: 'control', kind: 'x', idempotencyKey: 'k1' });
    const b = await q.enqueue({ queue: 'control', kind: 'x', idempotencyKey: 'k1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });

  it('a job is claimed by exactly one of many concurrent claimers', async () => {
    await q.enqueue({ queue: 'maintenance', kind: 'race', idempotencyKey: 'race-1' });
    const owners = Array.from({ length: 8 }, (_, i) => `w${i}`);
    const results = await Promise.all(owners.map((owner) => q.claimNext({ queue: 'maintenance', owner, leaseMs: 60_000 })));
    const claimed = results.filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe('ACTIVE');
    expect(claimed[0]!.attempts).toBe(1);
  });

  it('respects runAt and priority', async () => {
    const later = new Date(Date.now() + 60_000);
    await q.enqueue({ queue: 'workflow', kind: 'later', idempotencyKey: 'p-later', runAt: later, priority: 10 });
    await q.enqueue({ queue: 'workflow', kind: 'low', idempotencyKey: 'p-low', priority: 0 });
    await q.enqueue({ queue: 'workflow', kind: 'high', idempotencyKey: 'p-high', priority: 5 });
    const first = await q.claimNext({ queue: 'workflow', owner: 'w', leaseMs: 1000 });
    const second = await q.claimNext({ queue: 'workflow', owner: 'w', leaseMs: 1000 });
    const third = await q.claimNext({ queue: 'workflow', owner: 'w', leaseMs: 1000 });
    expect([first?.kind, second?.kind, third]).toEqual(['high', 'low', null]);
  });

  it('heartbeat only extends the owner lease; release can undo the attempt count', async () => {
    const { job } = await q.enqueue({ queue: 'humanizer', kind: 'h', idempotencyKey: 'hb-1' });
    const claimed = await q.claimNext({ queue: 'humanizer', owner: 'me', leaseMs: 1000 });
    expect(claimed?.id).toBe(job.id);
    expect(await q.heartbeatJob(job.id, 'someone-else', 1000)).toBe(false);
    expect(await q.heartbeatJob(job.id, 'me', 1000)).toBe(true);
    expect(await q.releaseJob(job.id, 'me', { runAt: new Date(), countAttempt: false })).toBe(true);
    const after = await client.queueJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('WAITING');
    expect(after.attempts).toBe(0);
  });

  it('failJob retries until maxAttempts then fails', async () => {
    const { job } = await q.enqueue({ queue: 'humanizer', kind: 'f', idempotencyKey: 'fail-1', maxAttempts: 2 });
    await q.claimNext({ queue: 'humanizer', owner: 'me', leaseMs: 1000, kinds: ['f'] });
    expect(await q.failJob(job.id, 'me', { error: 'boom', retryable: true })).toBe('retry');
    await q.claimNext({ queue: 'humanizer', owner: 'me', leaseMs: 1000, kinds: ['f'] });
    expect(await q.failJob(job.id, 'me', { error: 'boom', retryable: true })).toBe('failed');
    const after = await client.queueJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toBe('boom');
  });
});
