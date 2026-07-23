// ============================================================
// CodeMorph AI Engine — Mapping Engine
// Maps IR from source patterns to target patterns
// ============================================================
import type { ConversionContext, IRDocument, IRComponent, IRRoute } from '../models/ir.types';

export class MappingEngine {
  async map(ctx: ConversionContext, ir: IRDocument): Promise<IRDocument> {
    const mapper = this.getMapper(ctx.sourceFramework, ctx.targetFramework);
    return mapper(ir, ctx);
  }

  private getMapper(src: string, tgt: string): (ir: IRDocument, ctx: ConversionContext) => IRDocument {
    // FIX PHASE 24 — BUG #6 CRITIQUE: clés case-sensitive
    // Le backend envoie sourceFramework="flutter" (lowercase) mais les clés étaient PascalCase.
    // Résultat: JAMAIS de match → mappeur identity (ir => ir) → IR non mappé → screens paths incorrects.
    // Fix: normaliser src et tgt en lowercase puis matcher sur des clés normalisées.
    const srcNorm = src.toLowerCase().replace(/[\s_.-]/g, '');
    const tgtNorm = tgt.toLowerCase().replace(/[\s_.-]/g, '');
    const key = `${srcNorm}->${tgtNorm}`;

    // Log pour tracer quel mappeur est sélectionné
    console.log(`[MappingEngine] getMapper: src="${src}"→norm="${srcNorm}" tgt="${tgt}"→norm="${tgtNorm}" key="${key}"`);

    const mappers: Record<string, (ir: IRDocument, ctx: ConversionContext) => IRDocument> = {
      'flutter->react':          this.flutterToReact.bind(this),
      'flutter->reactnative':    this.flutterToReactNative.bind(this),
      'flutter->rn':             this.flutterToReactNative.bind(this),
      'dart->react':             this.flutterToReact.bind(this),
      'dart->reactnative':       this.flutterToReactNative.bind(this),
      'express->nestjs':         this.expressToNestJS.bind(this),
      'nodejs->nestjs':          this.nodeToNestJS.bind(this),
      'node->nestjs':            this.nodeToNestJS.bind(this),
    };

    const mapper = mappers[key];
    if (!mapper) {
      console.warn(`[MappingEngine] No mapper found for key="${key}" — using identity (IR unchanged). Available: ${Object.keys(mappers).join(', ')}`);
    } else {
      console.log(`[MappingEngine] Mapper selected for key="${key}" ✓`);
    }
    return mapper ?? ((ir) => ir);
  }

  // ── Flutter → React ──────────────────────────────────
  private flutterToReact(ir: IRDocument, _ctx: ConversionContext): IRDocument {
    const uiGraph = ir.uiGraph ?? { components: [], screens: [], stateFlow: [], stateSlices: [], navigationFlow: [], theme: {} };
    const backendGraph = ir.backendGraph ?? { routes: [], services: [], middlewares: [], entities: [] };
    return {
      ...ir,
      uiGraph: {
        ...uiGraph,
        components: (uiGraph.components ?? []).map((c) => this.mapFlutterWidgetToReact(c)),
        screens:    (uiGraph.screens ?? []).map((s) => ({
          ...s,
          path: `/src/pages/${s.name.toLowerCase()}`,
          route: s.route ?? `/${s.name.toLowerCase()}`,
        })),
      },
      backendGraph: {
        ...backendGraph,
        routes: (backendGraph.routes ?? []).map((r) => this.addApiPrefix(r, '/api')),
      },
    };
  }

  // ── Flutter → React Native ────────────────────────────
  private flutterToReactNative(ir: IRDocument, _ctx: ConversionContext): IRDocument {
    const uiGraph = ir.uiGraph ?? { components: [], screens: [], stateFlow: [], stateSlices: [], navigationFlow: [], theme: {} };
    return {
      ...ir,
      uiGraph: {
        ...uiGraph,
        components:     (uiGraph.components ?? []).map((c) => this.mapFlutterWidgetToRN(c)),
        screens:        (uiGraph.screens ?? []).map((s) => ({
          ...s,
          path: `src/screens/${s.name}Screen.tsx`,
        })),
        stateFlow:      uiGraph.stateFlow ?? [],
        navigationFlow: (uiGraph.navigationFlow ?? []).map((n) => ({
          ...n,
          trigger: (n.trigger ?? '').replace('push(', 'navigate(').replace('pop()', 'goBack()'),
        })),
      },
    };
  }

  // ── Express → NestJS ──────────────────────────────────
  private expressToNestJS(ir: IRDocument, _ctx: ConversionContext): IRDocument {
    const backendGraph = ir.backendGraph ?? { routes: [], services: [], middlewares: [], entities: [] };
    return {
      ...ir,
      backendGraph: {
        ...backendGraph,
        routes: (backendGraph.routes ?? []).map((r) => ({
          ...r,
          guards:      [...(r.guards ?? []), 'JwtAuthGuard'],
          middlewares: [...(r.middlewares ?? []), 'ValidationPipe'],
        })),
        services: (backendGraph.services ?? []).map((s) => ({
          ...s,
          injectable: true,
          dependencies: [...(s.dependencies ?? []).map((d) => `${d}Service`), 'InjectRepository'],
        })),
        middlewares: [
          ...(backendGraph.middlewares ?? []),
          { name: 'ValidationPipe',   scope: 'global' as const, type: 'validation' as const },
          { name: 'JwtAuthGuard',     scope: 'global' as const, type: 'auth' as const },
          { name: 'LoggingInterceptor', scope: 'global' as const, type: 'logging' as const },
        ],
      },
    };
  }

  // ── Node.js → NestJS ──────────────────────────────────
  private nodeToNestJS(ir: IRDocument, ctx: ConversionContext): IRDocument {
    return this.expressToNestJS(ir, ctx);
  }

  // ── Helpers ───────────────────────────────────────────
  private mapFlutterWidgetToReact(c: IRComponent): IRComponent {
    const typeMap: Record<string, IRComponent['type']> = {
      StatefulWidget:  'feature',
      StatelessWidget: 'ui',
      Screen:          'page',
      Page:            'page',
      Widget:          'ui',
    };
    return {
      ...c,
      type: typeMap[c.type] ?? c.type,
      styling: [...(c.styling ?? []), 'tailwind'],
    };
  }

  private mapFlutterWidgetToRN(c: IRComponent): IRComponent {
    return {
      ...c,
      styling: [...(c.styling ?? []), 'StyleSheet'],
    };
  }

  private addApiPrefix(route: IRRoute, prefix: string): IRRoute {
    return {
      ...route,
      path: route.path.startsWith(prefix) ? route.path : `${prefix}${route.path}`,
    };
  }
}
