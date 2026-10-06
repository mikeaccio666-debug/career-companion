import type { CareerRunContext, CareerRunPreparation, CareerSkillId } from './contracts.ts';
import { careerSkill } from './skills.ts';

/** A readiness plan, not a capability grant or an executor. Check scope again at every real port. */
export function prepareCareerRun(id: CareerSkillId, context: CareerRunContext): CareerRunPreparation {
  const skill = careerSkill(id);
  const reasons: string[] = [];
  if (!context.ownerId.trim() || !Number.isSafeInteger(context.profileRevision) || context.profileRevision < 1) reasons.push('invalid_authenticated_context');
  const selected = [];
  for (const input of skill.requiredInputs) {
    const candidates = context.inputs.filter(reference => reference.input === input && reference.ownerId === context.ownerId && reference.state === 'current' && reference.id.trim() && Number.isSafeInteger(reference.revision) && reference.revision > 0);
    if (candidates.length !== 1) { reasons.push(candidates.length ? `ambiguous_input:${input}` : `missing_input:${input}`); continue; }
    const reference = candidates[0]!;
    if ((input === 'profile' || input === 'confirmed-profile') && reference.revision !== context.profileRevision) { reasons.push(`profile_revision_changed:${input}`); continue; }
    selected.push({ ...reference });
  }
  for (const tool of skill.tools) if (context.tools[tool] !== 'ready') reasons.push(`tool_${context.tools[tool] === 'requires_connection' ? 'requires_connection' : 'unavailable'}:${tool}`);
  if (reasons.length) return { state: 'blocked', skillId: id, reasons };
  return { state: 'ready_for_draft', skillId: id, skillRevision: skill.revision, profileRevision: context.profileRevision, inputs: selected, tools: [...skill.tools], maxToolCalls: 12, maxModelTurns: 6, externalActions: 'forbidden', reviewRequired: true };
}
