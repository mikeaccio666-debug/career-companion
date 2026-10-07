import { P0_EVAL_CASES, PILOT_CASE_IDS, FORMAL_CASE_IDS, type ScriptCase, type P0EvalSpeaker } from './cases.ts';
import { baselineInput, evalDigest, BASELINE_PROMPT_DIGEST, BASELINE_PROMPT_REVISION } from './baseline-input.ts';

export type StudyStage = 'pilot' | 'full' | 'formal_pilot' | 'formal';
export interface EvalStudyEntry {
  readonly caseId: string; readonly scriptId: string; readonly scriptDigest: string;
  readonly seedInputDigest: string; readonly speaker: P0EvalSpeaker;
  readonly purpose: 'companion_reply' | 'expert_consult'; readonly stage: StudyStage;
}
export interface EvalStudyPlan {
  readonly version: 1; readonly scope: 'prompt_only'; readonly digest: string;
  readonly corpusDigest: string; readonly promptDigest: string; readonly promptRevision: string;
  readonly scripts: readonly ScriptCase[]; readonly entries: readonly EvalStudyEntry[];
  readonly developmentCaseIds: readonly string[]; readonly pilotCaseIds: readonly string[];
  readonly formalCaseIds: readonly string[]; readonly formalPilotCaseIds: readonly string[];
}
export class EvalStudyError extends Error {
  readonly code = 'EVAL_STUDY_INVALID';
  constructor() { super('The frozen evaluation study could not be confirmed.'); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Source-reviewed anchors, not an authority token. Any authored corpus/sample
// change requires review and an intentional anchor update; readonly is not a
// runtime guarantee when another module imports cases before this one.
const reviewed = Object.freeze({
  corpus: '9136dbd3e4fd78ce80fd9985e6e6410d7fb07e6fcf60c7fdcac2ab8b9ed199a4',
  pilot: '7bea24e43f082fd4022b0a5809289a571a0c8b1e9aa0ca2f7b1569d37c6abefd',
  formal: '8923a3a06e20c3ef3f97430d291703e63278ba64a172d78cebd635ad979d2844',
});
// Check captured clones before issuing any plan, including fresh-process import order.
const canonical = freeze(structuredClone(P0_EVAL_CASES));
const pilotIds = freeze([...PILOT_CASE_IDS]), formalIds = freeze([...FORMAL_CASE_IDS]);
const corpusDigest = evalDigest(canonical);
if (corpusDigest !== reviewed.corpus || evalDigest(pilotIds) !== reviewed.pilot || evalDigest(formalIds) !== reviewed.formal) {
  throw new EvalStudyError();
}
const issued = new WeakSet<EvalStudyPlan>();
/** Optional formal pilot is frozen from the existing formal20, not a new product sample. */
export function createEvalStudyPlan(options: { formalPilotIds?: readonly string[]; scripts?: readonly ScriptCase[] } = {}): EvalStudyPlan {
  if (options.scripts && evalDigest(options.scripts) !== corpusDigest) throw new EvalStudyError();
  const chosen = options.formalPilotIds ?? [];
  if (!Array.isArray(chosen) || new Set(chosen).size !== chosen.length || chosen.some(id => !formalIds.includes(id))) throw new EvalStudyError();
  const formalPilot = formalIds.filter(id => chosen.includes(id));
  const scripts = structuredClone(canonical);
  const byId = new Map(scripts.map(item => [item.id, item]));
  const entry = (scriptId: string, tier: 'development' | 'formal'): EvalStudyEntry => {
    const item = byId.get(scriptId)!;
    return { caseId: `${tier}/${scriptId}`, scriptId, scriptDigest: evalDigest(item),
      seedInputDigest: evalDigest(baselineInput(item)), speaker: item.speaker,
      purpose: item.speaker === 'companion' ? 'companion_reply' : 'expert_consult',
      stage: tier === 'development' ? pilotIds.includes(scriptId) ? 'pilot' : 'full'
        : formalPilot.includes(scriptId) ? 'formal_pilot' : 'formal' };
  };
  const entries = [...scripts.map(item => entry(item.id, 'development')), ...formalIds.map(id => entry(id, 'formal'))];
  const value = { version: 1 as const, scope: 'prompt_only' as const, corpusDigest,
    promptDigest: BASELINE_PROMPT_DIGEST, promptRevision: BASELINE_PROMPT_REVISION, scripts, entries,
    developmentCaseIds: scripts.map(item => `development/${item.id}`),
    pilotCaseIds: pilotIds.map(id => `development/${id}`), formalCaseIds: formalIds.map(id => `formal/${id}`),
    formalPilotCaseIds: formalPilot.map(id => `formal/${id}`) };
  const plan = freeze({ ...value, digest: evalDigest(value) }); issued.add(plan); return plan;
}
export function assertEvalStudyPlan(plan: EvalStudyPlan): void {
  if (!issued.has(plan)) throw new EvalStudyError();
}
export function studyEntry(plan: EvalStudyPlan, caseId: string): EvalStudyEntry {
  assertEvalStudyPlan(plan);
  const entry = plan.entries.find(item => item.caseId === caseId);
  if (!entry) throw new EvalStudyError(); return entry;
}
export function assertStudyInput(plan: EvalStudyPlan, caseId: string, supplied: ScriptCase): ScriptCase {
  const entry = studyEntry(plan, caseId);
  if (supplied.id !== entry.scriptId || evalDigest(supplied) !== entry.scriptDigest ||
      evalDigest(baselineInput(supplied)) !== entry.seedInputDigest) throw new EvalStudyError();
  return structuredClone(plan.scripts.find(item => item.id === entry.scriptId)!);
}
