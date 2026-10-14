import type { PipelineDefinition } from './types';

const pipelines = new Map<string, PipelineDefinition>();

export function registerPipeline(def: PipelineDefinition): void {
  pipelines.set(def.moduleKey, def);
}

export function getPipeline(moduleKey: string): PipelineDefinition | undefined {
  return pipelines.get(moduleKey);
}

export function unregisterPipeline(moduleKey: string): void {
  pipelines.delete(moduleKey);
}

export function registeredPipelines(): string[] {
  return [...pipelines.keys()];
}
