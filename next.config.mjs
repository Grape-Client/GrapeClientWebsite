import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: here },
  outputFileTracingRoot: here,
  async headers() {
    const strict = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ];
    return [
      { source: '/admin-grape', headers: [...strict, { key: 'X-Robots-Tag', value: 'noindex' }] },
      { source: '/api/admin/:path*', headers: strict },
      { source: '/link/:path*', headers: strict },
      { source: '/link', headers: strict },
    ];
  },
};
