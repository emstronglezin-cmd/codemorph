// ============================================================
// CodeMorph — Service Worker (Serwist / Workbox)
// ============================================================
import { defaultCache } from '@serwist/next/worker';
import {
  Serwist,
  CacheFirst,
  NetworkFirst,
  StaleWhileRevalidate,
  ExpirationPlugin,
  CacheableResponsePlugin,
} from 'serwist';

const revision = crypto.randomUUID();

const serwist = new Serwist({
  // __SW_MANIFEST is injected by @serwist/next webpack plugin at build time.
  // The string "self.__SW_MANIFEST" must stay verbatim in source.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  precacheEntries: (self as any).__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    // ── Next.js static chunks (immutable 1y) ──────────────────
    {
      matcher: ({ request, url }: { request: Request; url: URL }) =>
        request.destination === 'script' &&
        url.pathname.startsWith('/_next/static/'),
      handler: new CacheFirst({
        cacheName: 'next-static-js',
        plugins: [
          new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 365 * 24 * 60 * 60 }),
          new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
      }),
    },
    // ── Next.js CSS chunks (immutable 1y) ─────────────────────
    {
      matcher: ({ request, url }: { request: Request; url: URL }) =>
        request.destination === 'style' &&
        url.pathname.startsWith('/_next/static/'),
      handler: new CacheFirst({
        cacheName: 'next-static-css',
        plugins: [
          new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 365 * 24 * 60 * 60 }),
          new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
      }),
    },
    // ── Next.js images ────────────────────────────────────────
    {
      matcher: ({ request, url }: { request: Request; url: URL }) =>
        request.destination === 'image' &&
        url.pathname.startsWith('/_next/'),
      handler: new CacheFirst({
        cacheName: 'next-images',
        plugins: [
          new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 }),
          new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
      }),
    },
    // ── Google Fonts (CSS) ────────────────────────────────────
    {
      matcher: ({ url }: { url: URL }) =>
        url.origin === 'https://fonts.googleapis.com',
      handler: new StaleWhileRevalidate({
        cacheName: 'google-fonts-stylesheets',
        plugins: [new ExpirationPlugin({ maxAgeSeconds: 7 * 24 * 60 * 60 })],
      }),
    },
    // ── Google Fonts (files) ──────────────────────────────────
    {
      matcher: ({ url }: { url: URL }) =>
        url.origin === 'https://fonts.gstatic.com',
      handler: new CacheFirst({
        cacheName: 'google-fonts-webfonts',
        plugins: [
          new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 }),
          new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
      }),
    },
    // ── Public static assets ──────────────────────────────────
    {
      matcher: ({ url }: { url: URL }) =>
        url.pathname.startsWith('/icons/') ||
        url.pathname.startsWith('/screenshots/') ||
        url.pathname === '/favicon.ico' ||
        url.pathname === '/site.webmanifest',
      handler: new CacheFirst({
        cacheName: 'static-assets',
        plugins: [
          new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 }),
          new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
      }),
    },
    // ── API calls: NEVER cache — données utilisateur sensibles ─
    // FIX PHASE 2 — ISO-02 CRITIQUE : suppression du cache API cross-utilisateur
    // Avant : NetworkFirst sur *.onrender.com avec TTL 5min
    // → les réponses API (jobs, projets, quotas) d'un utilisateur pouvaient
    //   être servies à un autre utilisateur sans requête réseau pendant 5 minutes.
    // Fix : aucun cache sur les API (toujours Network-only via fetch natif).
    // Le Service Worker ne doit pas intercepter les appels API authentifiés.
    // Note : le matcher ci-dessous EXCLUT explicitement *.onrender.com et /api/
    // pour éviter tout risque de cache cross-utilisateur.
    // ── App shell pages ───────────────────────────────────────
    {
      matcher: ({ request }: { request: Request }) =>
        request.mode === 'navigate',
      handler: new NetworkFirst({
        cacheName: 'pages',
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 }),
          new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
      }),
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
