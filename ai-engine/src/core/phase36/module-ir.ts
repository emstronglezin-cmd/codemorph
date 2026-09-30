// ============================================================
// CodeMorph AI Engine — PHASE 36: Module IR — extraction + fusion
//
// Chaque chunk est analysé avec :
//   A. contexte global minimal nécessaire (renderGlobalContext)
//   B. contenu COMPLET du module traité
//   C. signatures des dépendances nécessaires
//   D. notes des modules déjà analysés si pertinentes
//
// Les ModuleIR sont ensuite FUSIONNÉES et RÉCONCILIÉES (dédupliquées,
// conflits résolus par priorité de provenance) dans une GlobalIR.
// On ne concatène JAMAIS simplement les réponses IA.
// ============================================================

import type { ChatMessage } from '../ai-provider';
import {
  getPhase36Config,
  estimateTokens,
} from './config';
import { withResilience } from './resilience';
import { renderGlobalContext, renderDependencyContext, moduleIRSummary } from './global-context';
import { assertInputBudget } from './scheduler';
import type {
  GlobalIR, IRComponentEntry, IRModelEntry, IRNavEdge, IRRouteEntry, IRScreenEntry,
  IRServiceEntry, IRStateEntry, MergeReport, ModuleIR, ProjectManifest, SemanticAIProvider, SemanticChunk,
} from './types';

// ── Prompt système compact (~140 tokens) ──────────────────────────────────────
const MODULE_IR_SYSTEM_PROMPT = `You are a precise code analyst. Analyze the given source files (one semantic module of a larger project) and extract a structured IR.

RULES:
- Extract ONLY what exists in the provided code. Use EXACT names from source. Never invent.
- Record relations (screen uses service, service uses model, store used by screen).
- Every screen: route, purpose, business logic, API calls, state.
- Every API call: method + URL.
- Partial file parts are marked (file.dart part 2/3): merge mentally with other parts, extract what is visible.
Return ONLY valid minified JSON, no markdown, no comments.`;

const MODULE_IR_INSTRUCTIONS = `Extract ALL of the following from THIS MODULE's files (empty array if none):

{"screens":[{"id":"screen-x","name":"XScreen","path":"<file>","route":"/x","components":["..."],"purpose":"...","businessLogic":["..."],"apiCalls":["POST /api/x"],"states":["loading"]}],
"components":[{"id":"comp-x","name":"X","type":"ui","path":"<file>","props":[{"name":"p","type":"T","required":true}],"children":[]}],
"navigationFlow":[{"from":"screen-a","to":"screen-b","trigger":"onTap","guard":""}],
"stateFlow":[{"store":"authStore","path":"<file>","type":"bloc|cubit|riverpod|zustand|provider|getx","stateShape":"{...}","actions":["login"]}],
"routes":[{"method":"POST","path":"/api/x","handler":"fn","guards":[],"middlewares":[]}],
"services":[{"name":"AuthService","path":"<file>","methods":[{"name":"login","params":["dto"],"returnType":"Token","async":true}],"dependencies":["UserRepo"]}],
"models":[{"name":"User","path":"<file>","table":"users","fields":[{"name":"id","type":"String","nullable":false,"unique":true,"primary":true}],"relations":[{"target":"Post","type":"one-to-many","field":"userId"}]}],
"apiCalls":[{"method":"POST","url":"/api/login","usedBy":"AuthService"}],
"envVars":["API_BASE_URL"],
"relations":[{"from":"LoginScreen","to":"AuthService","kind":"uses"}],
"notes":["important cross-module observations"]}`;

export interface ChunkAnalysisDeps {
  ai: SemanticAIProvider;
  model: string;
  /** jobId pour les logs AI structurés du job (structured-logger) */
  jobId?: string | undefined;
  manifest: ProjectManifest;
  /** Notes des modules déjà analysés : chunkId → ModuleIR */
  analyzed: Map<string, ModuleIR>;
  log: (line: string) => void;
  /** Injecté pour les tests */
  sleepFn?: (ms: number) => Promise<void>;
}

// ── Parseur JSON robuste (réponse du modèle) ──────────────────────────────────
export function parseModuleIRJSON(raw: string, chunk: SemanticChunk): ModuleIR {
  const empty: ModuleIR = {
    chunkId: chunk.id, moduleId: chunk.moduleId, role: chunk.role,
    files: chunk.files.map((f) => f.path), contentHashes: chunk.files.map((f) => f.contentHash),
    screens: [], components: [], navigationFlow: [], stateFlow: [], routes: [],
    services: [], models: [], apiCalls: [], envVars: [], relations: [], notes: [],
    tokensUsed: 0, cacheHit: false, durationMs: 0,
  };
  if (!raw || raw.trim().length === 0) return empty;

  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(s) as Record<string, unknown>;
  } catch {
    // Scan arrière pour trouver un JSON valide (réponse tronquée)
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s[i];
      if (c === '}' || c === ']') {
        try {
          parsed = JSON.parse(s.slice(0, i + 1)) as Record<string, unknown>;
          break;
        } catch { /* continue */ }
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  const arr = (key: string): unknown[] => (Array.isArray(parsed?.[key]) ? (parsed[key] as unknown[]) : []);

  return {
    chunkId: chunk.id,
    moduleId: chunk.moduleId,
    role: chunk.role,
    files: chunk.files.map((f) => f.path),
    contentHashes: chunk.files.map((f) => f.contentHash),
    screens:       arr('screens').map((x) => normalizeScreen(x)).filter((x): x is IRScreenEntry => x !== null),
    components:    arr('components').map((x) => normalizeComponent(x)).filter((x): x is IRComponentEntry => x !== null),
    navigationFlow:arr('navigationFlow').map((x) => normalizeNav(x)).filter((x): x is IRNavEdge => x !== null),
    stateFlow:     arr('stateFlow').map((x) => normalizeState(x)).filter((x): x is IRStateEntry => x !== null),
    routes:        arr('routes').map((x) => normalizeRoute(x)).filter((x): x is IRRouteEntry => x !== null),
    services:      arr('services').map((x) => normalizeService(x)).filter((x): x is IRServiceEntry => x !== null),
    models:        arr('models').map((x) => normalizeModel(x)).filter((x): x is IRModelEntry => x !== null),
    apiCalls:      arr('apiCalls').map((x) => normalizeApiCall(x)).filter((x): x is { method: string; url: string; usedBy: string } => x !== null),
    envVars:       arr('envVars').map((x) => String(x)).filter((x) => x.length > 0),
    relations:     arr('relations').map((x) => {
      const r = x as Record<string, unknown>;
      const from = typeof r['from'] === 'string' ? r['from'] : '';
      const to   = typeof r['to'] === 'string' ? r['to'] : '';
      const kind = typeof r['kind'] === 'string' ? r['kind'] : 'uses';
      return from && to ? { from, to, kind } : null;
    }).filter((x): x is { from: string; to: string; kind: string } => x !== null),
    notes:         arr('notes').map((x) => String(x)).slice(0, 12),
    tokensUsed: 0,
    cacheHit: false,
    durationMs: 0,
  };
}

type Obj = Record<string, unknown>;
const str = (o: Obj, k: string, d = ''): string => (typeof o[k] === 'string' ? (o[k] as string) : d);
const strArr = (o: Obj, k: string): string[] => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(String) : []);

function normalizeScreen(x: unknown): IRScreenEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const name = str(o, 'name');
  if (!name) return null;
  return {
    id: str(o, 'id') || `screen-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    path: str(o, 'path'),
    route: str(o, 'route') || `/${name.toLowerCase().replace(/screen$|page$|view$/i, '').replace(/[^a-z0-9]+/g, '-')}`,
    components: strArr(o, 'components'),
    purpose: str(o, 'purpose'),
    businessLogic: strArr(o, 'businessLogic'),
    apiCalls: strArr(o, 'apiCalls'),
    states: strArr(o, 'states'),
  };
}

function normalizeComponent(x: unknown): IRComponentEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const name = str(o, 'name');
  if (!name) return null;
  const rawProps = Array.isArray(o['props']) ? (o['props'] as unknown[]) : [];
  return {
    id: str(o, 'id') || `comp-${name.toLowerCase()}`,
    name,
    type: str(o, 'type', 'ui'),
    path: str(o, 'path'),
    props: rawProps.map((p) => {
      const po = (p && typeof p === 'object' ? p : {}) as Obj;
      return { name: str(po, 'name'), type: str(po, 'type', 'unknown'), required: po['required'] === true };
    }).filter((p) => p.name.length > 0),
    children: strArr(o, 'children'),
  };
}

function normalizeNav(x: unknown): IRNavEdge | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const from = str(o, 'from');
  const to = str(o, 'to');
  if (!from || !to) return null;
  return { from, to, trigger: str(o, 'trigger', 'navigate'), guard: str(o, 'guard') };
}

function normalizeState(x: unknown): IRStateEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const store = str(o, 'store');
  if (!store) return null;
  return {
    store,
    path: str(o, 'path'),
    type: str(o, 'type', 'unknown'),
    stateShape: str(o, 'stateShape'),
    actions: strArr(o, 'actions'),
  };
}

function normalizeRoute(x: unknown): IRRouteEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const path = str(o, 'path');
  if (!path) return null;
  return {
    method: str(o, 'method', 'GET').toUpperCase(),
    path,
    handler: str(o, 'handler'),
    guards: strArr(o, 'guards'),
    middlewares: strArr(o, 'middlewares'),
  };
}

function normalizeService(x: unknown): IRServiceEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const name = str(o, 'name');
  if (!name) return null;
  const rawMethods = Array.isArray(o['methods']) ? (o['methods'] as unknown[]) : [];
  return {
    name,
    path: str(o, 'path'),
    methods: rawMethods.map((m) => {
      const mo = (m && typeof m === 'object' ? m : {}) as Obj;
      const params = Array.isArray(mo['params'])
        ? (mo['params'] as unknown[]).map((p) => (typeof p === 'string' ? p : str(p as Obj, 'name')))
        : [];
      return {
        name: str(mo, 'name'),
        params,
        returnType: str(mo, 'returnType', 'void'),
        async: mo['async'] === true,
      };
    }).filter((m) => m.name.length > 0),
    dependencies: strArr(o, 'dependencies'),
  };
}

function normalizeModel(x: unknown): IRModelEntry | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const name = str(o, 'name');
  if (!name) return null;
  const rawFields = Array.isArray(o['fields']) ? (o['fields'] as unknown[]) : [];
  const rawRels = Array.isArray(o['relations']) ? (o['relations'] as unknown[]) : [];
  return {
    name,
    path: str(o, 'path'),
    table: str(o, 'table', `${name.toLowerCase()}s`),
    fields: rawFields.map((f) => {
      const fo = (f && typeof f === 'object' ? f : {}) as Obj;
      const fname = str(fo, 'name');
      return {
        name: fname,
        type: str(fo, 'type', 'String'),
        nullable: fo['nullable'] === true,
        unique: fo['unique'] === true,
        primary: fo['primary'] === true || fname === 'id',
      };
    }).filter((f) => f.name.length > 0),
    relations: rawRels.map((r) => {
      const ro = (r && typeof r === 'object' ? r : {}) as Obj;
      const target = str(ro, 'target');
      return target ? { target, type: str(ro, 'type', 'belongs-to'), field: str(ro, 'field') } : null;
    }).filter((r): r is { target: string; type: string; field: string } => r !== null),
  };
}

function normalizeApiCall(x: unknown): { method: string; url: string; usedBy: string } | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Obj;
  const url = str(o, 'url') || str(o, 'path');
  if (!url) return null;
  return { method: str(o, 'method', 'GET').toUpperCase(), url, usedBy: str(o, 'usedBy') };
}

// ── Analyse d'un chunk (1 appel IA budgété + résilience + cache en amont) ─────
export async function analyzeChunk(
  chunk: SemanticChunk,
  manifest: ProjectManifest,
  deps: ChunkAnalysisDeps,
): Promise<ModuleIR> {
  const cfg = getPhase36Config();
  const t0 = Date.now();

  // ── Construire le prompt (contexte global + deps + contenu complet du module) ──
  const globalCtx   = renderGlobalContext(manifest);
  const depCtx      = renderDependencyContext(manifest, chunk, deps.analyzed);
  const filesBlock  = Object.entries(chunk.filesContent)
    .map(([path, content]) => {
      const part = chunk.fileParts[path] ? ` (part ${chunk.fileParts[path]})` : '';
      return `===== SOURCE FILE: ${path}${part} =====\n${content}`;
    })
    .join('\n\n');

  const userPrompt = `${globalCtx}

${depCtx ? depCtx + '\n\n' : ''}MODULE TO ANALYZE: "${chunk.moduleId}" (role=${chunk.role}, ${chunk.files.length} file(s))
${MODULE_IR_INSTRUCTIONS}

${filesBlock}`;

  // ── Garde-fou budget : la requête ne part JAMAIS surdimensionnée ───────────
  const promptTokens = assertInputBudget(
    MODULE_IR_SYSTEM_PROMPT.length + userPrompt.length,
    `chunk ${chunk.id}`,
  );

  deps.log(
    `[AI-CHUNK] project=${manifest.projectId} chunk=${chunk.id} ` +
    `model=${deps.model} estimatedTokens=${promptTokens} contentTokens=${chunk.estimatedTokens} ` +
    `files=${chunk.files.length} deps=${chunk.externalDeps.length} status=analyzing`,
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: MODULE_IR_SYSTEM_PROMPT },
    { role: 'user',   content: userPrompt },
  ];

  const result = await withResilience(
    async () => {
      const res = await deps.ai.chat(messages, cfg.maxOutputTokens, undefined, deps.jobId);
      if (!res.content || res.content.trim().length === 0) {
        throw new Error('empty response from AI provider (429/body-too-large/timeout produce this)');
      }
      return res;
    },
    {
      context: { projectId: manifest.projectId, chunkId: chunk.id, phase: 'AI-MODULE-ANALYSIS' },
      log: deps.log,
      sleepFn: deps.sleepFn,
    },
  );

  const ir = parseModuleIRJSON(result.content, chunk);
  ir.tokensUsed = result.tokensUsed;
  ir.durationMs = Date.now() - t0;
  return ir;
}

// ── Fusion / réconciliation des ModuleIR en GlobalIR ───────────────────────────
const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function mergeModuleIRs(moduleIRs: ModuleIR[], manifest: ProjectManifest): { globalIR: GlobalIR; report: MergeReport } {
  const conflictsResolved: string[] = [];
  let duplicatesRemoved = 0;

  const screens = new Map<string, IRScreenEntry>();
  const components = new Map<string, IRComponentEntry>();
  const navEdges = new Map<string, IRNavEdge>();
  const stateFlow = new Map<string, IRStateEntry>();
  const routes = new Map<string, IRRouteEntry>();
  const services = new Map<string, IRServiceEntry>();
  const models = new Map<string, IRModelEntry>();
  const apiCalls = new Map<string, { method: string; url: string; usedBy: string }>();
  const relations: Array<{ from: string; to: string; kind: string }> = [];
  const envVars = new Set<string>();
  const provenance: Record<string, string[]> = {};

  const track = (entityId: string, chunkId: string): void => {
    provenance[entityId] = [...(provenance[entityId] ?? []), chunkId];
  };
  const dup = (key: string, chunkId: string): void => {
    if ((provenance[key]?.length ?? 0) > 0) duplicatesRemoved++;
    track(key, chunkId);
  };

  for (const ir of moduleIRs) {
    // ── Screens : dédup par nom normalisé ; en cas de conflit, fusionner les champs ──
    for (const s of ir.screens) {
      const key = `screen:${normName(s.name)}`;
      const existing = screens.get(key);
      if (existing) {
        dup(key, ir.chunkId);
        // Fusion additive : union des composants/logique/appels (ne rien perdre)
        existing.components = [...new Set([...existing.components, ...s.components])];
        existing.businessLogic = [...new Set([...existing.businessLogic, ...s.businessLogic])];
        existing.apiCalls = [...new Set([...existing.apiCalls, ...s.apiCalls])];
        existing.states = [...new Set([...existing.states, ...s.states])];
        if (!existing.path && s.path) existing.path = s.path;
        if (!existing.purpose && s.purpose) existing.purpose = s.purpose;
        conflictsResolved.push(`screen ${s.name}: merged duplicate declarations from ${ir.chunkId}`);
      } else {
        screens.set(key, { ...s });
        track(key, ir.chunkId);
      }
    }

    // ── Components : dédup par nom, fusion des props ──
    for (const c of ir.components) {
      const key = `comp:${normName(c.name)}`;
      const existing = components.get(key);
      if (existing) {
        dup(key, ir.chunkId);
        const propNames = new Set(existing.props.map((p) => p.name));
        for (const p of c.props) {
          if (!propNames.has(p.name)) existing.props.push(p);
        }
        existing.children = [...new Set([...existing.children, ...c.children])];
        if (!existing.path && c.path) existing.path = c.path;
      } else {
        components.set(key, { ...c });
        track(key, ir.chunkId);
      }
    }

    // ── Navigation : dédup exact (from,to,trigger) ──
    for (const n of ir.navigationFlow) {
      const key = `nav:${normName(n.from)}>${normName(n.to)}:${n.trigger}`;
      if (navEdges.has(key)) { dup(key, ir.chunkId); continue; }
      navEdges.set(key, { ...n });
      track(key, ir.chunkId);
    }

    // ── Stores ──
    for (const st of ir.stateFlow) {
      const key = `store:${normName(st.store)}`;
      const existing = stateFlow.get(key);
      if (existing) {
        dup(key, ir.chunkId);
        existing.actions = [...new Set([...existing.actions, ...st.actions])];
        if (!existing.path && st.path) existing.path = st.path;
        if (existing.stateShape.length < st.stateShape.length) existing.stateShape = st.stateShape;
      } else {
        stateFlow.set(key, { ...st });
        track(key, ir.chunkId);
      }
    }

    // ── Routes : dédup method+path ──
    for (const r of ir.routes) {
      const key = `route:${r.method}:${normName(r.path)}`;
      if (routes.has(key)) { dup(key, ir.chunkId); continue; }
      routes.set(key, { ...r });
      track(key, ir.chunkId);
    }

    // ── Services : dédup nom, fusion méthodes ──
    for (const sv of ir.services) {
      const key = `service:${normName(sv.name)}`;
      const existing = services.get(key);
      if (existing) {
        dup(key, ir.chunkId);
        const methodNames = new Set(existing.methods.map((m) => m.name));
        for (const m of sv.methods) {
          if (!methodNames.has(m.name)) existing.methods.push(m);
        }
        existing.dependencies = [...new Set([...existing.dependencies, ...sv.dependencies])];
        if (!existing.path && sv.path) existing.path = sv.path;
      } else {
        services.set(key, { ...sv });
        track(key, ir.chunkId);
      }
    }

    // ── Models : dédup nom, fusion champs + relations ──
    for (const m of ir.models) {
      const key = `model:${normName(m.name)}`;
      const existing = models.get(key);
      if (existing) {
        dup(key, ir.chunkId);
        const fieldNames = new Set(existing.fields.map((f) => f.name));
        for (const f of m.fields) {
          if (!fieldNames.has(f.name)) existing.fields.push(f);
        }
        const relTargets = new Set(existing.relations.map((r) => `${r.target}:${r.type}`));
        for (const r of m.relations) {
          if (!relTargets.has(`${r.target}:${r.type}`)) existing.relations.push(r);
        }
        if (!existing.path && m.path) existing.path = m.path;
      } else {
        models.set(key, { ...m });
        track(key, ir.chunkId);
      }
    }

    // ── API calls : dédup method+url+usedBy ──
    for (const a of ir.apiCalls) {
      const key = `api:${a.method}:${normName(a.url)}:${normName(a.usedBy || 'unknown')}`;
      if (apiCalls.has(key)) { dup(key, ir.chunkId); continue; }
      apiCalls.set(key, { ...a });
      track(key, ir.chunkId);
    }

    for (const e of ir.envVars) envVars.add(e);
    for (const r of ir.relations) {
      // dédup relations identiques
      const key = `${r.from}->${r.to}:${r.kind}`;
      if (!relations.some((x) => `${x.from}->${x.to}:${x.kind}` === key)) {
        relations.push({ ...r });
      }
    }
  }

  const globalIR: GlobalIR = {
    screens: [...screens.values()],
    components: [...components.values()],
    navigationFlow: [...navEdges.values()],
    stateFlow: [...stateFlow.values()],
    routes: [...routes.values()],
    services: [...services.values()],
    models: [...models.values()],
    apiCalls: [...apiCalls.values()],
    envVars: [...envVars],
    relations,
    moduleProvenance: provenance,
  };

  const report: MergeReport = {
    modulesMerged: moduleIRs.length,
    duplicatesRemoved,
    conflictsResolved: conflictsResolved.slice(0, 40),
    screens: globalIR.screens.length,
    components: globalIR.components.length,
    navigationFlow: globalIR.navigationFlow.length,
    stateFlow: globalIR.stateFlow.length,
    routes: globalIR.routes.length,
    services: globalIR.services.length,
    models: globalIR.models.length,
    apiCalls: globalIR.apiCalls.length,
    relations: globalIR.relations.length,
    status: moduleIRs.length === 0 ? 'failed' : 'success',
  };

  void manifest;
  return { globalIR, report };
}

/** Résumé compact de la GlobalIR pour les logs. */
export function summarizeGlobalIR(ir: GlobalIR): string {
  return [
    `screens=${ir.screens.length}`,
    `components=${ir.components.length}`,
    `nav=${ir.navigationFlow.length}`,
    `stores=${ir.stateFlow.length}`,
    `routes=${ir.routes.length}`,
    `services=${ir.services.length}`,
    `models=${ir.models.length}`,
    `apiCalls=${ir.apiCalls.length}`,
    `relations=${ir.relations.length}`,
  ].join(' ');
}

export { moduleIRSummary, estimateTokens };
