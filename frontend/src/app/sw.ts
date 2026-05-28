// ============================================================
// CodeMorph — Service Worker (Serwist / Workbox)
// Strategies:
//   - Shell (app routes): StaleWhileRevalidate
//   - Static assets (_next/static): CacheFirst (immutable)
//   - API calls:           NetworkFirst (no offline cache for auth)
//   - Fonts/CDN:           CacheFirst (30d)
//   - Offline fallback:    /offline
// ============================================================

import { defaultCache } from '@serwist/next/worker';
import { Serwist } from 'serwist';

const revision = crypto.randomUUID();

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    // ── Next.js static chunks (immutable 1y) ──────────────────
    {
      matcher: ({ request, url }: { request: Request; url: URL }) =>
        request.destination === 'script' &&
        url.pathname.startsWith('/_next/static/'),
      handler: 'CacheFirst',
      options: {
        cacheName: 'next-static-js',
        expiration: {
          maxEntries: 200,
          maxAgeSeconds: 365 * 24 * 60 * 60,
        },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ── Next.js CSS chunks (immutable 1y) ─────────────────────
    {
      matcher: ({ request, url }: { request: Request; url: URL }) =>
        request.destination === 'style' &&
        url.pathname.startsWith('/_next/static/'),
      handler: 'CacheFirst',
      options: {
        cacheName: 'next-static-css',
        expiration: {
          maxEntries: 50,
          maxAgeSeconds: 365 * 24 * 60 * 60,
        },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ── Next.js images ────────────────────────────────────────
    {
      matcher: ({ request, url }: { request: Request; url: URL }) =>
        request.destination === 'image' &&
        url.pathname.startsWith('/_next/'),
      handler: 'CacheFirst',
      options: {
        cacheName: 'next-images',
        expiration: {
          maxEntries: 100,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ── Google Fonts (CSS) ────────────────────────────────────
    {
      matcher: ({ url }: { url: URL }) =>
        url.origin === 'https://fonts.googleapis.com',
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'google-fonts-stylesheets',
        expiration: { maxAgeSeconds: 7 * 24 * 60 * 60 },
      },
    },
    // ── Google Fonts (files) ──────────────────────────────────
    {
      matcher: ({ url }: { url: URL }) =>
        url.origin === 'https://fonts.gstatic.com',
      handler: 'CacheFirst',
      options: {
        cacheName: 'google-fonts-webfonts',
        expiration: {
          maxEntries: 30,
          maxAgeSeconds: 365 * 24 * 60 * 60,
        },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ── Public static assets (icons, manifest) ────────────────
    {
      matcher: ({ url }: { url: URL }) =>
        url.pathname.startsWith('/icons/') ||
        url.pathname.startsWith('/screenshots/') ||
        url.pathname === '/favicon.ico' ||
        url.pathname === '/site.webmanifest',
      handler: 'CacheFirst',
      options: {
        cacheName: 'static-assets',
        expiration: {
          maxEntries: 60,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ── API calls: NetworkFirst (auth/data must be fresh) ─────
    {
      matcher: ({ url }: { url: URL }) =>
        url.pathname.startsWith('/api/') ||
        url.hostname.includes('onrender.com') ||
        url.hostname.includes('codemorph.dev'),
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api-cache',
        networkTimeoutSeconds: 10,
        expiration: {
          maxEntries: 50,
          maxAgeSeconds: 5 * 60,
        },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ── App shell pages (SWR) ─────────────────────────────────
    {
      matcher: ({ request }: { request: Request }) =>
        request.mode === 'navigate',
      handler: 'NetworkFirst',
      options: {
        cacheName: 'pages',
        networkTimeoutSeconds: 5,
        expiration: {
          maxEntries: 50,
          maxAgeSeconds: 24 * 60 * 60,
        },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ── Default fallback ──────────────────────────────────────
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher({ request }) {
          return request.destination === 'document';
        },
        revision,
      },
    ],
  },
});

serwist.addEventListeners();
