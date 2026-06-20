// ============================================================
// CodeMorph — Next.js Middleware
// Protection des routes dashboard (redirection si non connecté)
// Note: côté Edge runtime — pas d'accès à localStorage
// On vérifie uniquement le cookie refresh pour la redirection
// Le token JWT réel est vérifié par le layout client-side
// ============================================================
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Routes qui nécessitent une session
const PROTECTED_PREFIXES = ['/dashboard'];

// Routes publiques même si connecté
const PUBLIC_ROUTES = [
  '/auth/sign-in',
  '/auth/sign-up',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/oauth-success',
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Ignorer les ressources statiques et API
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.includes('.') // fichiers statiques (.ico, .png, etc.)
  ) {
    return NextResponse.next();
  }

  const isProtected = PROTECTED_PREFIXES.some(prefix => pathname.startsWith(prefix));

  if (!isProtected) {
    return NextResponse.next();
  }

  // Vérifier si le cookie refresh est présent (preuve de session)
  // Le vrai token JWT est dans localStorage — vérifié côté client
  const refreshCookie = request.cookies.get('cm_refresh_token');

  // Si pas de cookie ET pas d'header Authorization → redirection sign-in
  // Note: localStorage n'est pas accessible en Edge middleware
  // On laisse passer et le layout client gère la redirection si besoin
  if (!refreshCookie) {
    // Construire l'URL de redirection
    const signInUrl = new URL('/auth/sign-in', request.url);
    signInUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Matcher pour toutes les routes SAUF:
     * - _next/static (fichiers statiques)
     * - _next/image (optimisation images)
     * - favicon.ico
     * - images, fonts
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)',
  ],
};
