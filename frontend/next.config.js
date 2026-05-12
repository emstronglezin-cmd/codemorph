// ============================================================
// CodeMorph — Next.js 14 Configuration
// Target: Netlify (SSR via @netlify/plugin-nextjs)
// ============================================================

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server-side rendering — Netlify handles SSR via edge functions
  // No 'output: export' since we use middleware + dynamic routes
  reactStrictMode: true,
  swcMinify: true,

  // Transpile monorepo shared package
  transpilePackages: ['@codemorph/shared'],

  // Image optimization — allow backend domain
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
      {
        protocol: 'https',
        hostname: '*.codemorph.dev',
      },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  // Security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },

  // Redirects
  async redirects() {
    return [
      {
        source: '/login',
        destination: '/auth/sign-in',
        permanent: true,
      },
      {
        source: '/signup',
        destination: '/auth/sign-up',
        permanent: true,
      },
      {
        source: '/register',
        destination: '/auth/sign-up',
        permanent: true,
      },
    ];
  },

  // Webpack customisation (monorepo path resolution)
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },

  // Experimental features
  experimental: {
    // Optimise React Server Components
    serverComponentsExternalPackages: [],
  },

  // Compiler options
  compiler: {
    // Remove console.log in production
    removeConsole: process.env.NODE_ENV === 'production'
      ? { exclude: ['error', 'warn'] }
      : false,
  },
};

module.exports = nextConfig;
