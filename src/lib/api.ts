import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, type ApiErrorBody } from './errors';
import { checkDashboardRequest } from './security';
import { ensurePragmas } from './db';
import { errorMessage, log } from './log';

const MAX_BODY_BYTES = 2_000_000;

export interface RouteContext<B> {
  req: Request;
  body: B;
  params: Record<string, string>;
  searchParams: URLSearchParams;
}

type ParamsArg = { params: Promise<Record<string, string>> };

/**
 * Wrap a dashboard route handler: loopback/origin/CSRF checks, JSON body size
 * limit, Zod validation with field errors, and consistent error responses.
 */
export function route<S extends z.ZodType | undefined = undefined>(
  options: { body?: S },
  handler: (ctx: RouteContext<S extends z.ZodType ? z.output<S> : undefined>) => Promise<unknown>,
) {
  return async (req: Request, arg?: ParamsArg): Promise<Response> => {
    try {
      const check = checkDashboardRequest(req);
      if (!check.ok) throw new AppError(check.status, 'FORBIDDEN', check.message);
      await ensurePragmas();
      let body: unknown = undefined;
      if (options.body) {
        const length = Number(req.headers.get('content-length') ?? '0');
        if (length > MAX_BODY_BYTES) throw new AppError(413, 'TOO_LARGE', 'Request body is too large.');
        const text = await req.text();
        if (text.length > MAX_BODY_BYTES) throw new AppError(413, 'TOO_LARGE', 'Request body is too large.');
        let raw: unknown;
        try {
          raw = text ? JSON.parse(text) : {};
        } catch {
          throw new AppError(400, 'BAD_JSON', 'Request body must be valid JSON.');
        }
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) throw validationError(parsed.error);
        body = parsed.data;
      }
      const params = arg?.params ? await arg.params : {};
      const result = await handler({
        req,
        body: body as S extends z.ZodType ? z.output<S> : undefined,
        params,
        searchParams: new URL(req.url).searchParams,
      });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (error) {
      return errorResponse(error, req);
    }
  };
}

export function validationError(error: z.ZodError): AppError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_form';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  const first = error.issues[0];
  const message = first ? `${first.path.length ? first.path.join('.') + ': ' : ''}${first.message}` : 'Invalid input.';
  return new AppError(400, 'VALIDATION', message, fieldErrors);
}

export function errorResponse(error: unknown, req?: Request): Response {
  if (error instanceof AppError) {
    const body: ApiErrorBody = { error: { code: error.code, message: error.message, fieldErrors: error.fieldErrors } };
    return NextResponse.json(body, { status: error.status });
  }
  if (error instanceof z.ZodError) return errorResponse(validationError(error), req);
  const message = errorMessage(error);
  void log({ level: 'error', category: 'api', message: `Unhandled API error: ${message}`, details: { url: req?.url } });
  const body: ApiErrorBody = { error: { code: 'INTERNAL', message: `Unexpected server error: ${message}` } };
  return NextResponse.json(body, { status: 500 });
}
