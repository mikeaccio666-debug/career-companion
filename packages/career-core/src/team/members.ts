import { EXPERT_KEYS, type ExpertKey } from '@companion/platform-contracts';
export interface ExpertMember { readonly key: ExpertKey; readonly label: string; readonly callNames: readonly string[]; }
/** Canonical names from 03 §4.4; a name is not evidence of an enabled service. */
export const EXPERT_MEMBERS: readonly Readonly<ExpertMember>[] = Object.freeze([
  { key: 'planner', label: '规划师', callNames: ['规划师', '规'] },
  { key: 'guide', label: '前辈', callNames: ['前辈', '前'] },
  { key: 'coach', label: '技能教练', callNames: ['技能教练', '教练', '教'] },
  { key: 'interviewer', label: '面试官', callNames: ['面试官', '面'] },
  { key: 'networker', label: '人脉官', callNames: ['人脉官', '脉'] },
  { key: 'applier', label: '投递官', callNames: ['投递官', '投'] },
].map(v => Object.freeze({ ...v, key: v.key as ExpertKey, callNames: Object.freeze(v.callNames) })));
export const P0_EXPERT_KEYS: readonly ExpertKey[] = Object.freeze(['guide', 'applier', 'interviewer']);
export class ExpertRosterError extends Error {
  constructor() { super('EXPERT_ROSTER_INVALID'); this.name = 'ExpertRosterError'; }
}
function expertArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw new ExpertRosterError();
  const ds=Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).length !== value.length + 1) throw new ExpertRosterError();
  const result=[];
  for(let i=0;i<value.length;i++){const d=ds[i];if(!d || !('value' in d) || !d.enumerable)throw new ExpertRosterError();result.push(d.value);}
  return result;
}
/** The caller chooses enabled keys from actual server configuration. This is
 * not a grant, feature flag, release switch or student-supplied roster. */
export function enabledExpertRoster(keys: readonly ExpertKey[] = P0_EXPERT_KEYS): readonly Readonly<ExpertMember>[] {
  const values=expertArray(keys,EXPERT_KEYS.length);
  if(new Set(values).size!==values.length || values.some(k=>!EXPERT_KEYS.includes(k as ExpertKey)))throw new ExpertRosterError();
  return Object.freeze(values.map(key=>EXPERT_MEMBERS.find(m=>m.key===key)!));
}
export function expertRosterKeys(roster: readonly ExpertMember[]): ReadonlySet<ExpertKey> {
  const keys:ExpertKey[]=[];
  for(const member of expertArray(roster,EXPERT_KEYS.length)) {
    if(!member || typeof member!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(member)))throw new ExpertRosterError();
    const ds=Object.getOwnPropertyDescriptors(member);
    if(Reflect.ownKeys(ds).length!==3 || ['key','label','callNames'].some(k=>!ds[k] || !('value' in ds[k]) || !ds[k].enumerable))throw new ExpertRosterError();
    const original=EXPERT_MEMBERS.find(m=>m.key===ds.key.value);
    const names=expertArray(ds.callNames.value,3);
    if(!original || original.label!==ds.label.value || names.length!==original.callNames.length || names.some((n,i)=>n!==original.callNames[i]))throw new ExpertRosterError();
    keys.push(original.key);
  }
  if(new Set(keys).size!==keys.length)throw new ExpertRosterError();
  return new Set(keys);
}
