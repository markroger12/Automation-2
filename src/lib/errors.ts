/** Errors with a user-facing message and an HTTP status for route handlers. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} was not found.`);
export const badRequest = (message: string, fieldErrors?: Record<string, string[]>) =>
  new AppError(400, 'BAD_REQUEST', message, fieldErrors);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const forbidden = (message: string) => new AppError(403, 'FORBIDDEN', message);

export interface ApiErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
}
