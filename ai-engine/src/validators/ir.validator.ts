// ============================================================
// CodeMorph AI Engine — IR Validator
// ============================================================
import type { IRDocument } from '../models/ir.types';

export class IRValidator {
  async validate(ir: IRDocument): Promise<IRDocument> {
    // Defensive guards: handle incomplete IR from fallback generators
    const validation = ir.validation ?? { warnings: [], blockers: [], buildable: true, riskLevel: 'low' };
    const projectMeta = ir.projectMeta ?? { name: 'unknown', sourceStack: 'Flutter', targetStack: 'React', complexityScore: 50 };
    const architecture = ir.architecture ?? { modules: [], patterns: [], layers: [] };
    const conversionPlan = ir.conversionPlan ?? [];

    const warnings: string[] = [...(validation.warnings ?? [])];
    const blockers:  string[] = [...(validation.blockers ?? [])];

    if (!projectMeta.name) blockers.push('projectMeta.name is required');
    if (!projectMeta.sourceStack) blockers.push('projectMeta.sourceStack is required');
    if (!projectMeta.targetStack) blockers.push('projectMeta.targetStack is required');
    if ((projectMeta.complexityScore ?? 0) < 0 || (projectMeta.complexityScore ?? 0) > 100) {
      warnings.push('complexityScore must be 0-100, clamping');
      projectMeta.complexityScore = Math.min(100, Math.max(0, projectMeta.complexityScore ?? 50));
    }
    if (conversionPlan.length === 0) warnings.push('conversionPlan is empty');
    if (architecture.modules.length === 0) warnings.push('No architecture modules detected');

    return {
      ...ir,
      validation: {
        ...validation,
        buildable:  blockers.length === 0,
        riskLevel:  blockers.length > 0 ? 'critical' : warnings.length > 2 ? 'high' : warnings.length > 0 ? 'medium' : 'low',
        warnings,
        blockers,
      },
    };
  }
}
