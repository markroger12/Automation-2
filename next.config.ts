import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

// Local-only dashboard: a strict CSP with no third-party origins.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'" + (isDev ? ' ws://localhost:3000 ws://127.0.0.1:3000' : ''),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  // The desktop app's build (BAS_STANDALONE=1, the Windows workflow): Next.js also writes the server with only the files
  // it needs (.next/standalone), so the installer carries a few hundred files of Next.js instead of thousands
  // (owner request 2026-11-12: a faster install). `npm run build` without it is unchanged.
  ...(process.env.BAS_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@prisma/client', 'sharp', 'playwright', 'playwright-core', 'opentype.js'],
  devIndicators: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
