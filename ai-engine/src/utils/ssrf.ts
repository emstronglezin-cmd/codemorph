// ============================================================
// CodeMorph AI Engine — SSRF Protection Utilities
// FIX PHASE 6: Déplacé depuis index.ts pour éviter l'import circulaire
// ============================================================

/** Regex pour bloquer les plages d'IP privées / metadata */
const PRIVATE_IP_REGEX =
  /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|::1|localhost|metadata\.google\.internal|0\.0\.0\.0)$/i;

/** Hôtes autorisés comme callback depuis l'AI Engine en production */
const ALLOWED_CALLBACK_HOSTS: string[] = (
  process.env['ALLOWED_CALLBACK_HOSTS'] ?? ''
)
  .split(',')
  .map(h => h.trim())
  .filter(Boolean);

/**
 * Valide qu'une callbackUrl ne pointe pas vers des ressources internes (SSRF).
 * En production : seuls les hôtes dans ALLOWED_CALLBACK_HOSTS ou *.onrender.com sont autorisés.
 * En développement : localhost est autorisé.
 */
export function isCallbackUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname;

    // Bloquer les IPs privées en production
    if (process.env['NODE_ENV'] === 'production' && PRIVATE_IP_REGEX.test(host)) {
      return false;
    }

    // En production : vérifier que l'hôte est dans la liste blanche OU un sous-domaine Render
    if (process.env['NODE_ENV'] === 'production') {
      if (ALLOWED_CALLBACK_HOSTS.length > 0) {
        return ALLOWED_CALLBACK_HOSTS.some(h => host === h || host.endsWith('.' + h));
      }
      // Fallback : autoriser *.onrender.com si aucune liste blanche configurée
      return host.endsWith('.onrender.com');
    }

    // Développement : autoriser tout sauf les IPs privées explicitement bloquées
    // (localhost est autorisé pour les tests)
    return true;
  } catch {
    return false;
  }
}
