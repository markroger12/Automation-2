/**
 * Typed pipeline errors. The engine maps each class to a specific, honest task
 * state instead of a generic failure.
 */

/** Temporary problem (network, timeout, DOM not ready). Retried with backoff. */
export class TransientError extends Error {
  readonly kind = 'transient' as const;
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TransientError';
  }
}

/** Configuration/security/validation problem: never retried automatically. */
export class FatalError extends Error {
  readonly kind = 'fatal' as const;
  constructor(message: string, public readonly nextAction?: string) {
    super(message);
    this.name = 'FatalError';
  }
}

/** ChatGPT or WordPress needs a manual sign-in. Pauses the task (not a failure). */
export class LoginRequiredError extends Error {
  readonly kind = 'login' as const;
  constructor(public readonly scope: 'chatgpt' | 'wordpress', message: string, public readonly websiteId?: string) {
    super(message);
    this.name = 'LoginRequiredError';
  }
}

/** A human verification step is shown; the owner completes it manually. */
export class HumanCheckError extends Error {
  readonly kind = 'human' as const;
  constructor(message: string) {
    super(message);
    this.name = 'HumanCheckError';
  }
}

/** Account usage cap or sustained 429; resume no earlier than retryAt. */
export class UsageLimitError extends Error {
  readonly kind = 'usage' as const;
  constructor(message: string, public readonly retryAt: Date) {
    super(message);
    this.name = 'UsageLimitError';
  }
}

/** The task was cancelled by the owner. */
export class CancelledError extends Error {
  readonly kind = 'cancelled' as const;
  constructor(message = 'Cancelled by the owner') {
    super(message);
    this.name = 'CancelledError';
  }
}

/**
 * An external side effect may or may not have happened (prompt sent, post
 * created) and success cannot be proven. Pause for review instead of repeating.
 */
export class UncertainSideEffectError extends Error {
  readonly kind = 'uncertain' as const;
  constructor(message: string, public readonly evidence: Record<string, unknown> = {}) {
    super(message);
    this.name = 'UncertainSideEffectError';
  }
}

/** Quality/validation rule failed: keep content, ask the owner to review. */
export class NeedsReviewError extends Error {
  readonly kind = 'review' as const;
  constructor(message: string, public readonly reasons: string[] = [message], public readonly nextAction?: string) {
    super(message);
    this.name = 'NeedsReviewError';
  }
}

export type PipelineError =
  | TransientError
  | FatalError
  | LoginRequiredError
  | HumanCheckError
  | UsageLimitError
  | CancelledError
  | UncertainSideEffectError
  | NeedsReviewError;

export function isPipelineError(error: unknown): error is PipelineError {
  return typeof error === 'object' && error !== null && 'kind' in error && typeof (error as { kind: unknown }).kind === 'string';
}
