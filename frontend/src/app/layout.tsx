import type React from 'react';
// ============================================================
// CodeMorph — Root Layout (Next.js 14 App Router)
// PWA-ready: manifest, theme-color, apple meta, viewport
// ============================================================
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import '@/styles/globals.css';
import { PwaInstallBanner } from '@/components/shared/pwa-install-banner';
import { Providers } from '@/components/providers';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://codemorph.dev'
  ),
  title: {
    default: 'CodeMorph — AI-Powered Code Conversion',
    template: '%s | CodeMorph',
  },
  description:
    'Transform your codebase with AI precision. CodeMorph converts code between languages and frameworks with enterprise-grade reliability.',
  keywords: [
    'code conversion',
    'AI',
    'TypeScript',
    'code migration',
    'developer tools',
    'Flutter to React',
    'React Native',
    'framework migration',
  ],
  authors: [{ name: 'CodeMorph Team' }],
  creator: 'CodeMorph',
  applicationName: 'CodeMorph',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'CodeMorph',
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://codemorph.dev',
    siteName: 'CodeMorph',
    title: 'CodeMorph — AI-Powered Code Conversion',
    description: 'Transform your codebase with AI precision.',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'CodeMorph' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CodeMorph',
    description: 'Transform your codebase with AI precision.',
    images: ['/og-image.png'],
    creator: '@codemorph',
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [
      { url: '/icons/icon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: [
      { url: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
    ],
    other: [
      { rel: 'mask-icon', url: '/icons/safari-pinned-tab.svg', color: '#6366f1' },
    ],
  },
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)',  color: '#0a0a0f' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* PWA splash screens — iOS */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512x512.png" />
        {/* MS Tile */}
        <meta name="msapplication-TileColor" content="#6366f1" />
        <meta name="msapplication-TileImage" content="/icons/icon-144x144.png" />
        {/* Mobile browser bar color */}
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="min-h-screen bg-background antialiased">
        <Providers>
          {/* PWA install banner — smart prompt for eligible browsers */}
          <PwaInstallBanner />
          {children}
        </Providers>
      </body>
    </html>
  );
}
