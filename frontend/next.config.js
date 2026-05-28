// ============================================================
// CodeMorph — Next.js 14 Configuration
// Target: Netlify (SSR via @netlify/plugin-nextjs)
// PWA:    @serwist/next (Workbox-based service worker)
// ============================================================

const withSerwist = require('@serwist/next').default;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server-side rendering — Netlify handles SSR via edge functions
  reactStrictMode: true,
  swcMinify: true,

  // Transpile monorepo shared package
  transpilePackages: ['@codemorph/shared'],

  // Image optimization
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: '*.codemorph.dev' },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  // Security + PWA headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      // Service worker — must be served at root, no caching
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, proxy-revalidate' },
          { key: 'Content-Type',  value: 'application/javascript; charset=utf-8' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      // Manifest
      {
        source: '/site.webmanifest',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },
      // Immutable static assets
      {
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      // PWA icons
      {
        source: '/icons/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=2592000' },
        ],
      },
    ];
  },

  // Redirects
  async redirects() {
    return [
      { source: '/login',    destination: '/auth/sign-in', permanent: true },
      { source: '/signup',   destination: '/auth/sign-up', permanent: true },
      { source: '/register', destination: '/auth/sign-up', permanent: true },
    ];
  },

  // Webpack customisation (monorepo path resolution)
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },

  // Compiler options
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production'
      ? { exclude: ['error', 'warn'] }
      : false,
  },
};

// ── Wrap with Serwist PWA ────────────────────────────────────────────────────
// disable: false in production, true in development (avoid SW in dev)
const withSerwistConfig = withSerwist({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  // Inject the SW manifest into the service worker
  injectionPoint: 'self.__SW_MANIFEST',
  // Scope: entire site
  scope: '/',
  // Reload on update (critical for auth apps)
  reloadOnOnline: true,
});

module.exports = withSerwistConfig(nextConfig);
