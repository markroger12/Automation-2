import { registerPipeline } from './pipeline/registry';
import { celebrityPipeline } from './pipelines/celebrity';
import { tigramPipeline } from './pipelines/tigram';
import { validateManifest } from '@/modules/types';

/** Registers the active writer pipelines (exactly two; Celebrity Writer 2.0 is retired). */
export function registerBuiltInPipelines(): void {
  for (const def of [celebrityPipeline, tigramPipeline]) {
    const problems = validateManifest(def.manifest);
    if (problems.length) throw new Error(`Invalid pipeline ${def.moduleKey}: ${problems.join('; ')}`);
    registerPipeline(def);
  }
}
