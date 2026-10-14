import type { StageKind, TaskStatus } from '@/lib/domain';

/**
 * Client-safe writer module manifests. Server pipelines (src/worker/pipelines)
 * attach `run` implementations to these stage definitions. Never import
 * worker/browser code from here.
 */
export interface StageManifest {
  key: string;
  label: string;
  kind: StageKind;
  runningStatus: TaskStatus;
  /** Task percent when this stage starts (0–100). */
  progress: number;
  /** Stage keys whose outputs this stage consumes (drives regeneration). */
  dependsOn: string[];
  /** PromptTemplate used by this stage, if any. */
  prompt?: { moduleKey: string; stageKey: string };
  description: string;
  /** 3.0 checkpoint group shown in the UI. */
  checkpoint?:
    | 'PRECHECK'
    | 'ROUTE'
    | 'RESEARCH_EVIDENCE'
    | 'DUPLICATE_PRECHECK'
    | 'EXISTING_WRITER_STAGES'
    | 'INTERNAL_LINKS'
    | 'IMAGE_STUDIO'
    | 'QUALITY_GATE'
    | 'WORDPRESS_DRAFT'
    | 'RANKMATH'
    | 'VERIFIED_COMPLETE';
  /** Regenerating this stage is allowed from the UI. */
  regenerable?: boolean;
}

export interface ModuleManifest {
  key: string;
  name: string;
  shortName: string;
  description: string;
  icon: string;
  group: 'writer';
  /** Only active modules may create new tasks. */
  active: boolean;
  /** Retired module kept only to display historical records. */
  legacy?: boolean;
  stages: StageManifest[];
  /** Whether Example Article Title is used: always, or only if the saved template has {{example_title}}. */
  exampleTitle: 'always' | 'if-template-variable';
  /** Secondary keywords are rendered in these prompt stage keys. */
  secondaryKeywordStages: string[];
  /** Short bullet list for the Writers page. */
  highlights: string[];
}

/** Stage plus every transitive dependent, in pipeline order. */
export function regenerationPlan(manifest: ModuleManifest, stageKey: string): string[] {
  const keys = new Set<string>([stageKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of manifest.stages) {
      if (!keys.has(stage.key) && stage.dependsOn.some((d) => keys.has(d))) {
        keys.add(stage.key);
        changed = true;
      }
    }
  }
  return manifest.stages.filter((s) => keys.has(s.key)).map((s) => s.key);
}

/** Validate a manifest's dependency graph (no unknown/forward dependencies). */
export function validateManifest(manifest: ModuleManifest): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const stage of manifest.stages) {
    if (seen.has(stage.key)) problems.push(`duplicate stage key ${stage.key}`);
    for (const dep of stage.dependsOn) {
      if (!seen.has(dep)) problems.push(`${stage.key} depends on ${dep}, which is not an earlier stage`);
    }
    seen.add(stage.key);
  }
  return problems;
}
