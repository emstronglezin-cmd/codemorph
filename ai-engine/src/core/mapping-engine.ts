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
    const key = `${src}->${tgt}`;
    const mappers: Record<string, (ir: IRDocument, ctx: ConversionContext) => IRDocument> = {
      'Flutter->React':          this.flutterToReact.bind(this),
      'Flutter->React Native':   this.flutterToReactNative.bind(this),
      'Express->NestJS':         this.expressToNestJS.bind(this),
      'Node.js->NestJS':         this.nodeToNestJS.bind(this),
    };
    return mappers[key] ?? ((ir) => ir);
  }

  // ── Flutter → React ──────────────────────────────────
  private flutterToReact(ir: IRDocument, _ctx: ConversionContext): IRDocument {
    const uiGraph = ir.uiGraph ?? { components: [], screens: [], stateSlices: [], theme: {} };
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
    const uiGraph = ir.uiGraph ?? { components: [], screens: [], stateSlices: [], theme: {} };
    return {
      ...ir,
      uiGraph: {
        ...uiGraph,
        components: (uiGraph.components ?? []).map((c) => this.mapFlutterWidgetToRN(c)),
        screens:    ir.uiGraph.screens.map((s) => ({
          ...s,
          path: `src/screens/${s.name}Screen.tsx`,
        })),
        navigationFlow: ir.uiGraph.navigationFlow.map((n) => ({
          ...n,
          trigger: n.trigger.replace('push(', 'navigate(').replace('pop()', 'goBack()'),
        })),
      },
    };
  }

  // ── Express → NestJS ──────────────────────────────────
  private expressToNestJS(ir: IRDocument, _ctx: ConversionContext): IRDocument {
    return {
      ...ir,
      backendGraph: {
        ...ir.backendGraph,
        routes: ir.backendGraph.routes.map((r) => ({
          ...r,
          guards:      [...(r.guards ?? []), 'JwtAuthGuard'],
          middlewares: [...(r.middlewares ?? []), 'ValidationPipe'],
        })),
        services: ir.backendGraph.services.map((s) => ({
          ...s,
          injectable: true,
          dependencies: [...s.dependencies.map((d) => `${d}Service`), 'InjectRepository'],
        })),
        middlewares: [
          ...ir.backendGraph.middlewares,
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
