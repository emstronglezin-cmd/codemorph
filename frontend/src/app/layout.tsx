// ============================================================
// CodeMorph — Root Layout (Next.js 14 App Router)
// ============================================================
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import '@/styles/globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'CodeMorph — AI-Powered Code Conversion',
    template: '%s | CodeMorph',
  },
  description:
    'Transform your codebase with AI precision. CodeMorph converts code between languages and frameworks with enterprise-grade reliability.',
  keywords: ['code conversion', 'AI', 'TypeScript', 'code migration', 'developer tools'],
  authors: [{ name: 'CodeMorph Team' }],
  creator: 'CodeMorph',
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
    icon: '/favicon.ico',
    shortcut: '/favicon-16x16.png',
    apple: '/apple-touch-icon.png',
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
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">
        {/* Providers will wrap here (QueryClient, ThemeProvider, etc.) */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

// ── Providers stub (will be expanded) ────────────────────
function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
