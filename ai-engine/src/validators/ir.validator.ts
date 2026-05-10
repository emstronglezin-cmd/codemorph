// ============================================================
// CodeMorph AI Engine — IR Validator
// ============================================================
import type { IRDocument } from '../models/ir.types';

export class IRValidator {
  async validate(ir: IRDocument): Promise<IRDocument> {
    const warnings: string[] = [...(ir.validation.warnings ?? [])];
    const blockers:  string[] = [...(ir.validation.blockers ?? [])];

    if (!ir.projectMeta.name) blockers.push('projectMeta.name is required');
    if (!ir.projectMeta.sourceStack) blockers.push('projectMeta.sourceStack is required');
    if (!ir.projectMeta.targetStack) blockers.push('projectMeta.targetStack is required');
    if (ir.projectMeta.complexityScore < 0 || ir.projectMeta.complexityScore > 100) {
      warnings.push('complexityScore must be 0-100, clamping');
      ir.projectMeta.complexityScore = Math.min(100, Math.max(0, ir.projectMeta.complexityScore));
    }
    if (ir.conversionPlan.length === 0) warnings.push('conversionPlan is empty');
    if (ir.architecture.modules.length === 0) warnings.push('No architecture modules detected');

    return {
      ...ir,
      validation: {
        ...ir.validation,
        buildable:  blockers.length === 0,
        riskLevel:  blockers.length > 0 ? 'critical' : warnings.length > 2 ? 'high' : warnings.length > 0 ? 'medium' : 'low',
        warnings,
        blockers,
      },
    };
  }
}
