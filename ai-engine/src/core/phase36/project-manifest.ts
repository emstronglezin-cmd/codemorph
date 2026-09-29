// ============================================================
// CodeMorph AI Engine — PHASE 36: Project Manifest (analyse globale statique)
//
// Représentation structurée du projet COMPLET, construite SANS aucun appel IA :
//   architecture, fichiers, modules, dépendances, imports, exports, routes,
//   écrans, composants, services, modèles, API, stockage, état, configuration,
//   relations entre fichiers et entre modules.
//
// Ce manifest sert de contexte de référence pour TOUS les chunks —
// on ne renvoie JAMAIS les 195K caractères complets dans chaque requête.
// ============================================================

import { createHash } from 'crypto';
import type { ASTResult, ASTFile } from '../ast-analyzer';
import type { ArchResult } from '../architecture-detector';
import type {
  FileSemanticRole, ManifestFile, ManifestRelation, ProjectManifest, SemanticModule,
} from './types';
import { SEMANTIC_ROLE_ORDER } from './types';
import { getPhase36Config, estimateTokens } from './config';

// ── Détection du rôle sémantique d'un fichier ─────────────────────────────────
export function detectFileRole(path: string): FileSemanticRole {
  const p = path.toLowerCase();
  if (/\.test\.|\.spec\.|__tests__|\/test(s)?\//.test(p)) return 'test';
  if (/readme|changelog|license|\.md$|docs?\//.test(p)) return 'doc';
  if (/pubspec\.yaml|package\.json|tsconfig|\.env|app\.config|theme|colors|styles\.dart|constants/i.test(p) && !/screen|page/.test(p)) return 'config';
  if (/router|navigation|routes?|app_bar|bottom_nav|main\.dart|app\.dart|_layout|tabs?\.|stack/i.test(p)) return 'navigation';
  if (/login|auth|sign[_-]?in|sign[_-]?up|register|otp|session|token[_-]?manager/i.test(p)) return 'auth';
  if (/\/models?\/|\.model\.|_model\.dart|entity|dto|schema/i.test(p)) return 'model';
  if (/\/services?\/|\.service\.|api[_-]?client|repository|repo\.dart|datasource|_api\.dart|network/i.test(p)) return 'service';
  if (/\/(blocs?|stores?|providers?|cubits?|notifiers?|state)\//.test(p) || /_bloc\.|_store\.|_cubit\.|_notifier\.|_provider\.|store\.ts|slice\.|zustand|redux/i.test(p)) return 'state';
  if (/screen|page|view(s)?\//.test(p)) return 'screen';
  if (/\/widget(s)?\/|\/components?\//.test(p) || /_widget\.|widget\.dart|component\./.test(p)) return 'component';
  if (/\/utils?\/|\/helpers?\/|\/lib\/util|extension|formatter|validator/i.test(p)) return 'utility';
  if (/controller|middleware|handler|endpoint/i.test(p)) return 'backend';
  if (/\.(png|jpg|svg|ttf|otf|woff|gif|webp|ico)$/i.test(p)) return 'asset-config';
  return 'misc';
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 24);
}

/** Résoud un import vers un chemin de fichier du projet (best-effort). */
function resolveImportToProjectFile(imp: string, allPaths: string[]): string | null {
  // Import Dart : package:mon_app/features/auth/login_screen.dart → features/auth/login_screen.dart
  let candidate = '';
  const pkgMatch = imp.match(/package:([^']+)\.dart/);
  if (pkgMatch?.[1]) {
    candidate = pkgMatch[1]; // ex: mon_app/features/auth/login_screen
  } else {
    const quoteMatch = imp.match(/['"]([^'"]+)['"]/);
    if (quoteMatch?.[1]) {
      candidate = quoteMatch[1].replace(/^\.\//, '').replace(/^\.\.\//, '');
    } else {
      // Import JS/TS : './stores/auth.store' ou 'src/services/api'
      const bare = imp.replace(/import\s+|from\s+|require\(|\)/g, '').trim().replace(/['"]/g, '');
      candidate = bare.replace(/^\.\//, '').replace(/^\.\.\//, '');
    }
  }
  if (!candidate || candidate.length < 3) return null;
  // Chercher un fichier du projet dont le chemin contient le candidat (sans extension d'abord)
  const normalized = candidate.replace(/\\/g, '/').replace(/\.dart$|\.tsx?$|\.jsx?$/i, '');
  // Match exact suffix
  let hit = allPaths.find((p) => {
    const pNorm = p.replace(/\\/g, '/').replace(/\.[^.]+$/, '');
    return pNorm === normalized || pNorm.endsWith('/' + normalized) || pNorm.endsWith(normalized);
  });
  if (!hit) {
    // Match par basename (ex: 'login_screen' → '.../login_screen.dart')
    const base = normalized.split('/').pop() ?? '';
    if (base.length >= 4) {
      hit = allPaths.find((p) => {
        const pBase = p.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
        return pBase === base;
      });
    }
  }
  return hit ?? null;
}

// ── Construction du manifest global ───────────────────────────────────────────
export function buildProjectManifest(
  projectId: string,
  sourceFramework: string,
  targetFramework: string,
  ast: ASTResult,
  _arch: ArchResult,
): ProjectManifest {
  const codeFiles = ast.files.filter((f) => !/\.test\.|\.spec\.|__tests__/.test(f.path));

  const files: ManifestFile[] = codeFiles.map((f: ASTFile) => ({
    path:         f.path,
    role:         detectFileRole(f.path),
    chars:        f.content?.length ?? 0,
    lines:        f.lines ?? (f.content ? f.content.split('\n').length : 0),
    classes:      f.classes ?? [],
    functions:    f.functions ?? [],
    imports:      f.imports ?? [],
    exports:      f.exports ?? [],
    contentHash:  hashContent(f.content ?? ''),
  }));

  const allPaths = files.map((f) => f.path);

  // ── Relations import → fichier résolues ────────────────────────────────────
  const relations: ManifestRelation[] = [];
  for (const f of files) {
    for (const imp of f.imports) {
      const resolved = resolveImportToProjectFile(imp, allPaths);
      if (resolved && resolved !== f.path) {
        relations.push({ from: f.path, to: resolved });
      }
    }
  }

  // ── Regroupement sémantique en modules ─────────────────────────────────────
  const byRole = new Map<FileSemanticRole, ManifestFile[]>();
  for (const f of files) {
    const arr = byRole.get(f.role) ?? [];
    arr.push(f);
    byRole.set(f.role, arr);
  }

  const modules: SemanticModule[] = [];
  for (const role of byRole.keys()) {
    const roleFiles = byRole.get(role) ?? [];
    const id = role;
    modules.push({
      id,
      role,
      files: roleFiles,
      totalChars: roleFiles.reduce((a, f) => a + f.chars, 0),
      dependsOn: [],
      dependents: [],
    });
  }

  // ── Dépendances entre modules (fichier → rôle du fichier importé) ──────────
  const roleOfPath = new Map<string, FileSemanticRole>();
  for (const f of files) roleOfPath.set(f.path, f.role);
  for (const rel of relations) {
    const fromRole = roleOfPath.get(rel.from);
    const toRole   = roleOfPath.get(rel.to);
    if (fromRole && toRole && fromRole !== toRole) {
      const fromMod = modules.find((m) => m.id === fromRole);
      const toMod   = modules.find((m) => m.id === toRole);
      if (fromMod && toMod && !fromMod.dependsOn.includes(toMod.id)) {
        fromMod.dependsOn.push(toMod.id);
        toMod.dependents.push(fromMod.id);
      }
    }
  }

  // ── Ordonner les modules selon l'ordre sémantique (dépendus d'abord) ────────
  modules.sort((a, b) => {
    const ia = SEMANTIC_ROLE_ORDER.indexOf(a.role);
    const ib = SEMANTIC_ROLE_ORDER.indexOf(b.role);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const roleCounts: Record<string, number> = {};
  for (const [role, arr] of byRole.entries()) roleCounts[role] = arr.length;

  return {
    projectId,
    sourceFramework,
    targetFramework,
    totalFiles: files.length,
    totalChars: files.reduce((a, f) => a + f.chars, 0),
    totalLines: files.reduce((a, f) => a + f.lines, 0),
    files,
    roleCounts,
    relations,
    modules,
    statePatterns:    ast.statePatterns ?? [],
    navigationPattern: ast.navigationPattern ?? 'unknown',
    authPatterns:     ast.authPatterns ?? [],
    storagePatterns:  ast.storagePatterns ?? [],
    apiPatterns:      ast.apiPatterns ?? [],
    externalServices: ast.externalServices ?? [],
    envVarKeys:       ast.envVarKeys ?? [],
    dependencies:     (ast.dependencies ?? []).map((d) => `${d.name ?? ''}${d.version ? '@' + d.version : ''}`),
  };
}

// ── Décision : ce projet doit-il passer par le pipeline sémantique ? ──────────
export function shouldUseSemanticPipeline(
  sourceChars: number,
  fileCount: number,
  tier: string,
): { use: boolean; reason: string } {
  const cfg = getPhase36Config();
  if (!cfg.enabled) return { use: false, reason: 'PHASE36_ENABLED=false' };
  if (tier === 'static' || tier === 'transpile') return { use: false, reason: `tier=${tier} (no AI)` };
  if (sourceChars > cfg.thresholdChars) return { use: true, reason: `chars=${sourceChars} > ${cfg.thresholdChars}` };
  if (fileCount > cfg.thresholdFiles) return { use: true, reason: `files=${fileCount} > ${cfg.thresholdFiles}` };
  return { use: false, reason: `small project (chars=${sourceChars} files=${fileCount} ≤ thresholds) — legacy pipeline preserved` };
}

// ── Compactage global (utilisé par global-context) ─────────────────────────────
export function estimateManifestTokens(manifest: ProjectManifest): number {
  return estimateTokens(JSON.stringify({
    files: manifest.files.map((f) => f.path),
    relations: manifest.relations.length,
  }));
}
