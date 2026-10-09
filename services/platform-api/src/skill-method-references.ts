import { careerRecordObject } from '@companion/platform-contracts';
import { CAREER_SKILLS, orgArray, orgInteger, orgText, type CareerSkillId } from '@companion/career-core';
export interface SkillMethodRef { readonly methodId: string; readonly revision: number; }
export type SkillMethodBindings = Readonly<Partial<Record<CareerSkillId, readonly SkillMethodRef[]>>>;
export interface SkillMethodRead { readonly skillId: CareerSkillId; readonly detail: 'excerpt' | 'full'; }
export function parseSkillMethodRefs(input: unknown): readonly SkillMethodRef[] {
  const refs = orgArray(input, value => {
    const v = careerRecordObject(value, ['methodId', 'revision']), methodId = orgText(v.methodId, 100);
    if (!/^[a-z][a-z0-9_.-]*$/.test(methodId)) throw Error('Invalid method reference.');
    return Object.freeze({ methodId, revision: orgInteger(v.revision, 1, 2147483647) });
  }, 3);
  if (new Set(refs.map(ref => ref.methodId)).size !== refs.length) throw Error('Duplicate method reference.');
  return refs;
}
/** A server-reviewed manifest, copied once. Model arguments cannot select versions. */
export function freezeSkillMethodBindings(input: SkillMethodBindings = {}): SkillMethodBindings {
  const v = careerRecordObject(input, [], CAREER_SKILLS.map(skill => skill.id));
  return Object.freeze(Object.fromEntries(CAREER_SKILLS.map(skill =>
    [skill.id, parseSkillMethodRefs(v[skill.id] ?? skill.methodRefs)])));
}
