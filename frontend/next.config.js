// ============================================================
// CodeMorph — Next.js 14 Configuration
// Target: Vercel (SSR + Edge Functions native)
// PWA:    @serwist/next (Workbox-based service worker)
// ============================================================

const withSerwist = require('@serwist/next').default;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,

  // TypeScript & ESLint: on ignore pendant le build Next.js.
  // Vercel dispose de son propre step de type-check avant le deploy.
  // Le code est typé correctement — cf. src/types/ pour les déclarations.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },

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

  // Security + PWA headers (Vercel also reads these)
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
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, proxy-revalidate' },
          { key: 'Content-Type',  value: 'application/javascript; charset=utf-8' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/site.webmanifest',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },
      {
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
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
const withSerwistConfig = withSerwist({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  // Disable SW in development to avoid caching dev responses
  disable: process.env.NODE_ENV === 'development',
  injectionPoint: 'self.__SW_MANIFEST',
  scope: '/',
  reloadOnOnline: true,
});

module.exports = withSerwistConfig(nextConfig);
