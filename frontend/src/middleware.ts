// ============================================================
// CodeMorph — Next.js Middleware (Edge Runtime)
// IMPORTANT: localStorage n'est PAS accessible ici (Edge Runtime)
// La protection des routes est gérée côté client dans DashboardLayout
// Ce middleware ne fait que du routing minimal (headers, CORS)
// ============================================================
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Passer toutes les requêtes — la protection est côté client (AuthGuard)
  // Le middleware Edge ne peut pas accéder à localStorage pour vérifier le JWT
  const response = NextResponse.next();

  // Ajouter des headers de sécurité utiles
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  return response;
}

export const config = {
  // N'intercepter que les pages (pas les assets statiques)
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|css|js)$).*)',
  ],
};
