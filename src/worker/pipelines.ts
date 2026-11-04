import { registerPipeline } from './pipeline/registry';
import { celebrityPipeline } from './pipelines/celebrity';
import { celebrity2Pipeline } from './pipelines/celebrity2';
import { tigramPipeline } from './pipelines/tigram';
import { validateManifest } from '@/modules/types';

/** Registers the active writer pipelines (Celebrity, Celebrity 2, Tigram; Celebrity Writer 2.0 is retired). */
export function registerBuiltInPipelines(): void {
  for (const def of [celebrityPipeline, celebrity2Pipeline, tigramPipeline]) {
    const problems = validateManifest(def.manifest);
    if (problems.length) throw new Error(`Invalid pipeline ${def.moduleKey}: ${problems.join('; ')}`);
    registerPipeline(def);
  }
}
