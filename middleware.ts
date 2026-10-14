import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE, isLoopbackHost, randomToken } from './src/lib/security';

/**
 * Login-free local dashboard guard: refuse non-loopback Host headers and make
 * sure every browser has a CSRF double-submit cookie. The extension agent
 * route authenticates with its bearer key instead.
 */
export function middleware(req: NextRequest) {
  if (!isLoopbackHost(req.headers.get('host'))) {
    return new NextResponse('Blog Automation Studio only accepts requests addressed to localhost.', { status: 403 });
  }
  const res = NextResponse.next();
  if (!req.cookies.get(CSRF_COOKIE)?.value) {
    res.cookies.set(CSRF_COOKIE, randomToken(), {
      httpOnly: false,
      sameSite: 'strict',
      secure: req.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
