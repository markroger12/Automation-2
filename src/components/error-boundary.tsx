'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '@/lib/client/report-error';

/**
 * Keeps one part of the screen from taking the whole dashboard down (owner report 2026-11-12: after a help-assistant
 * answer the dashboard showed only “Application error: a client-side exception has occurred”). A part that fails shows
 * `fallback` (or nothing), the rest of the page keeps working, and the error goes to the app's log.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; name: string; fallback?: (error: Error, reset: () => void) => ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}]`, error, info.componentStack);
    reportClientError(Object.assign(new Error(error.message), { name: error.name, stack: `${error.stack ?? ''}\nComponent stack:${info.componentStack ?? ''}` }), this.props.name);
    try {
      this.props.onError?.(error);
    } catch {
      /* a failing cleanup must not hide the fallback */
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) return this.props.fallback ? this.props.fallback(this.state.error, this.reset) : null;
    return this.props.children;
  }
}
