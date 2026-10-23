import { registerLoop, type WorkerContext } from './runtime';
import { ArticleDispatcher } from './dispatcher';
import { healOrphanedTasks, recoverOnStartup, sweepExpiredLeases } from './recovery';
import { controlTick } from './control';
import { humanizerTick } from './humanizer';
import { workflowTick } from './workflow-queue';
import { plagiarismTick } from './plagiarism';
import { schedulerTick } from '@/lib/workflow/scheduler';
import { scheduleDailyEvaluations } from '@/lib/refresh/service';
import { pruneDiagnostics } from './maintenance';
import { chromeAutostartTick } from './chrome-autostart';
import { indexingTick, syncDue, syncWebsite } from '@/lib/gsc/sync';
import { registerBuiltInPipelines } from './pipelines';
import { registerBuiltInControlHandlers } from './handlers';

let dispatcher: ArticleDispatcher | null = null;

/** Registers the worker's processing loops. */
export async function registerBuiltInLoops(ctx: WorkerContext): Promise<void> {
  registerBuiltInPipelines();
  registerBuiltInControlHandlers();
  await recoverOnStartup(ctx.workerId);
  dispatcher = new ArticleDispatcher(ctx.workerId);
  const d = dispatcher;
  registerLoop({ name: 'article-dispatcher', intervalMs: 1000, run: async (c) => d.tick(c.stopping) });
  registerLoop({ name: 'control-queue', intervalMs: 1000, run: async (c) => controlTick(c.workerId, c.stopping) });
  registerLoop({ name: 'humanizer-queue', intervalMs: 1000, run: async (c) => humanizerTick(c.workerId, c.stopping) });
  registerLoop({ name: 'workflow-queue', intervalMs: 1000, run: async (c) => workflowTick(c.workerId, c.stopping) });
  registerLoop({ name: 'plagiarism-checks', intervalMs: 1000, run: async (c) => plagiarismTick(c.workerId, c.stopping) });
  // Publishing scheduler: database only, enqueues jobs, never opens a browser itself.
  registerLoop({ name: 'workflow-scheduler', intervalMs: 60_000, run: async () => void (await schedulerTick()) });
  // Content refresh: one read-only evaluation per website and day (enqueues only).
  registerLoop({ name: 'refresh-scheduler', intervalMs: 3600_000, run: async () => void (await scheduleDailyEvaluations()) });
  // Search Console: “Request indexing” queued for Automation Chrome after a publish; with the key, live data every 2 h
  // (one website per tick) and Google's index proof.
  registerLoop({
    name: 'search-console',
    intervalMs: 30_000,
    run: async () => {
      await indexingTick();
      const [next] = await syncDue();
      if (next) await syncWebsite(next).catch(() => undefined); // the failure is stored and logged by syncWebsite
    },
  });
  // ChatGPT work waiting and no extension connected: open Automation Chrome (Settings → Browser; at most every 3 min).
  registerLoop({ name: 'chatgpt-chrome-autostart', intervalMs: 10_000, run: async () => void (await chromeAutostartTick()) });
  registerLoop({ name: 'lease-sweeper', intervalMs: 15_000, run: async () => void (await sweepExpiredLeases()) });
  registerLoop({ name: 'orphan-healer', intervalMs: 60_000, run: async () => void (await healOrphanedTasks()) });
  registerLoop({ name: 'retention', intervalMs: 6 * 3600_000, run: async () => void (await pruneDiagnostics()) });
}

/** Let in-flight article work reach a safe point before exit. */
export async function onShutdown(): Promise<void> {
  if (dispatcher && dispatcher.activeCount > 0) await dispatcher.drain(10_000);
}
