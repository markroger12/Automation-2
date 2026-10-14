import type { WorkerContext } from './runtime';

/** Registers the worker's processing loops. Queue processing arrives in M2. */
export async function registerBuiltInLoops(_ctx: WorkerContext): Promise<void> {
  // Intentionally empty in M1.
}

export async function onShutdown(): Promise<void> {
  // Nothing to drain in M1.
}
