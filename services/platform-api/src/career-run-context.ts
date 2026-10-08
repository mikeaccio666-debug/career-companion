import { createHash } from 'node:crypto';
import { careerSkill, type CareerInput, type CareerInputReference, type CareerRunContext, type CareerSkillId, type CareerTool } from '@companion/career-core';
import { ApiError } from './errors.ts';

export interface CareerOwnerScope { ownerId: string; signal?: AbortSignal; }
/** Ports return only normal-sensitivity summaries, not resumes, identity fields, emails or secrets. */
export interface OwnedCareerInput {
  ownerId: string; id: string; revision: number; state: 'current' | 'stale' | 'withdrawn'; normalSummary: string;
}
export interface OwnedCareerProfile extends OwnedCareerInput { confirmed: { degree: boolean; graduation: boolean; roleFamily: boolean }; }
export interface OwnedCareerTarget extends OwnedCareerInput { status: 'active' | 'exploring' | 'archived'; }
export interface OwnedCareerApplication extends OwnedCareerInput { stage: 'saved' | 'applied' | 'oa' | 'interview' | 'offer' | 'closed'; track: string; }
export interface OwnedCareerEvidence extends OwnedCareerInput { kind: 'project' | 'practice_review' | 'other'; }
export interface OwnedCareerResume extends OwnedCareerInput { status: 'active' | 'draft' | 'archived'; track: string;
  /** Actual immutable owner approval time, never inferred from list order or revision. */
  approvedAt?: string;
}
export interface OwnedKnowledgeAccess extends OwnedCareerInput { empty: boolean; }
/** Authenticated server dependencies. No endpoint accepts this structure from a request. Missing ports remain unavailable. */
export interface CareerRunPorts {
  readProfile?(scope: CareerOwnerScope): Promise<OwnedCareerProfile | null>;
  listTargets?(scope: CareerOwnerScope): Promise<readonly OwnedCareerTarget[]>;
  listApplications?(scope: CareerOwnerScope): Promise<readonly OwnedCareerApplication[]>;
  listEvidence?(scope: CareerOwnerScope): Promise<readonly OwnedCareerEvidence[]>;
  listResumeVersions?(scope: CareerOwnerScope): Promise<readonly OwnedCareerResume[]>;
  readUploadedResume?(scope: CareerOwnerScope, id: string): Promise<OwnedCareerInput | null>;
  readKnowledgeAccess?(scope: CareerOwnerScope): Promise<OwnedKnowledgeAccess | null>;
  readConversationGoal?(scope: CareerOwnerScope, messageId: string): Promise<OwnedCareerInput | null>;
  readContact?(scope: CareerOwnerScope, contactId: string): Promise<OwnedCareerInput | null>;
}
export interface CareerInputSelection { targetId?: string; targetJobId?: string; projectId?: string; resumeId?: string; uploadedResumeId?: string; goalMessageId?: string; contactId?: string; }
export interface BuiltCareerRunContext {
  context: CareerRunContext;
  summaries: { input: CareerInput; label: string; text: string }[];
  /** The future run record persists these members; PR2 has no fake persistence or new tables. */
  snapshots: { input: CareerInput; id: string; members: { id: string; revision: number }[] }[];
  unavailableSources: string[];
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new ApiError(499, 'CAREER_PREPARATION_CANCELLED', 'Career preparation was cancelled.'); }
function valid(record: OwnedCareerInput, ownerId: string): boolean {
  return record.ownerId === ownerId && record.state === 'current' && typeof record.id === 'string' && !!record.id.trim() && record.id.length <= 240 && Number.isSafeInteger(record.revision) && record.revision > 0 && record.revision <= 2147483647 && typeof record.normalSummary === 'string' && record.normalSummary.length <= 1000;
}
/** A collection is one stable input, not several competing current references. */
export function careerInputSnapshot(ownerId: string, input: CareerInput, rows: readonly OwnedCareerInput[]): { reference: CareerInputReference; members: { id: string; revision: number }[] } | undefined {
  const current = rows.filter(row => valid(row, ownerId));
  if (!current.length) return undefined;
  const members = current.map(row => ({ id: row.id, revision: row.revision })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision);
  if (new Set(members.map(member => member.id)).size !== members.length) return undefined;
  const id = `snap_${createHash('sha256').update(JSON.stringify({ ownerId, input, members })).digest('hex')}`;
  // Revision 1 identifies this immutable content-addressed snapshot, never a mutable profile or knowledge batch.
  return { reference: { input, id, revision: 1, ownerId, state: 'current' }, members };
}

export async function buildCareerRunContext(input: { ownerId: string; skillId: CareerSkillId; ports: CareerRunPorts; tools: CareerRunContext['tools']; signal?: AbortSignal; selection?: CareerInputSelection }): Promise<BuiltCareerRunContext> {
  if (!input.ownerId.trim()) throw new ApiError(403, 'TOOL_NOT_ALLOWED', 'An authenticated owner is required.');
  cancelled(input.signal);
  const skill = careerSkill(input.skillId), needs = new Set(skill.requiredInputs), scope = { ownerId: input.ownerId, signal: input.signal }, selection = input.selection ?? {};
  const unavailableSources: string[] = [];
  async function read<T>(name: keyof CareerRunPorts, fn: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (!fn) { unavailableSources.push(name); return undefined; }
    const result = await fn(); cancelled(input.signal); return result;
  }
  const [profile, targets, applications, evidence, resumes, upload, knowledge, goal, contact] = await Promise.all([
    read('readProfile', input.ports.readProfile && (() => input.ports.readProfile!(scope))),
    needs.has('target-role') || needs.has('target-direction') ? read('listTargets', input.ports.listTargets && (() => input.ports.listTargets!(scope))) : undefined,
    needs.has('target-job') || needs.has('current-jobs') || needs.has('reviewed-resume') ? read('listApplications', input.ports.listApplications && (() => input.ports.listApplications!(scope))) : undefined,
    needs.has('project-facts') || needs.has('skill-gaps') ? read('listEvidence', input.ports.listEvidence && (() => input.ports.listEvidence!(scope))) : undefined,
    needs.has('resume-source') || needs.has('reviewed-resume') ? read('listResumeVersions', input.ports.listResumeVersions && (() => input.ports.listResumeVersions!(scope))) : undefined,
    needs.has('resume-source') && selection.uploadedResumeId ? read('readUploadedResume', input.ports.readUploadedResume && (() => input.ports.readUploadedResume!(scope, selection.uploadedResumeId!))) : undefined,
    needs.has('knowledge') ? read('readKnowledgeAccess', input.ports.readKnowledgeAccess && (() => input.ports.readKnowledgeAccess!(scope))) : undefined,
    needs.has('conversation-goal') && selection.goalMessageId ? read('readConversationGoal', input.ports.readConversationGoal && (() => input.ports.readConversationGoal!(scope, selection.goalMessageId!))) : undefined,
    needs.has('contact') && selection.contactId ? read('readContact', input.ports.readContact && (() => input.ports.readContact!(scope, selection.contactId!))) : undefined,
  ]);
  const inputs: CareerInputReference[] = [], summaries: BuiltCareerRunContext['summaries'] = [], snapshots: BuiltCareerRunContext['snapshots'] = [];
  function addOne(name: CareerInput, rows: readonly OwnedCareerInput[], selectedId?: string, label: string = name): void {
    const current = rows.filter(row => valid(row, input.ownerId) && (!selectedId || row.id === selectedId));
    // Ambiguity stays visible to prepareCareerRun rather than selecting an arbitrary record.
    for (const row of current) { inputs.push({ input: name, id: row.id, revision: row.revision, ownerId: input.ownerId, state: 'current' }); summaries.push({ input: name, label, text: row.normalSummary }); }
  }
  function aggregate(name: CareerInput, rows: readonly OwnedCareerInput[], minimum = 1): void {
    const current = rows.filter(row => valid(row, input.ownerId));
    if (current.length < minimum) return;
    const result = careerInputSnapshot(input.ownerId, name, current);
    if (!result) return;
    inputs.push(result.reference); snapshots.push({ input: name, id: result.reference.id, members: result.members });
    summaries.push({ input: name, label: name, text: `${result.members.length} owned current records: ${current.map(row => row.normalSummary).join('\n').slice(0, 4000)}` });
  }
  const ownedProfile = profile && valid(profile, input.ownerId) ? profile : undefined;
  if (ownedProfile) {
    if (needs.has('profile')) addOne('profile', [ownedProfile]);
    if (needs.has('confirmed-profile') && ownedProfile.confirmed.degree === true && ownedProfile.confirmed.graduation === true && ownedProfile.confirmed.roleFamily === true) addOne('confirmed-profile', [ownedProfile]);
  }
  const liveTargets = (targets ?? []).filter(row => ['active', 'exploring'].includes(row.status));
  if (needs.has('target-role')) selection.targetId ? addOne('target-role', liveTargets, selection.targetId) : aggregate('target-role', liveTargets);
  if (needs.has('target-direction')) aggregate('target-direction', liveTargets.filter(row => row.status === 'active'));
  const liveJobs = (applications ?? []).filter(row => ['saved', 'applied', 'oa', 'interview', 'offer'].includes(row.stage));
  if (needs.has('target-job')) addOne('target-job', liveJobs, selection.targetJobId);
  if (needs.has('current-jobs')) aggregate('current-jobs', liveJobs, 3);
  const projects = (evidence ?? []).filter(row => row.kind === 'project');
  if (needs.has('project-facts')) selection.projectId ? addOne('project-facts', projects, selection.projectId) : aggregate('project-facts', projects);
  if (needs.has('skill-gaps')) aggregate('skill-gaps', (evidence ?? []).filter(row => row.kind === 'practice_review'), 3);
  const activeResumes = (resumes ?? []).filter(row => row.status === 'active');
  function selectResume(rows: readonly OwnedCareerResume[], selectedId?: string): readonly OwnedCareerResume[] {
    const current = rows.filter(row => valid(row, input.ownerId) && (!selectedId || row.id === selectedId));
    if (selectedId || current.length <= 1) return current;
    // Product 03 §3.4 selects the latest active original. Only actual approval
    // times can establish recency; old ports without that evidence stay ambiguous.
    const timed = current.every(row => typeof row.approvedAt === 'string' && Number.isFinite(Date.parse(row.approvedAt)) && new Date(row.approvedAt).toISOString() === row.approvedAt);
    if (!timed) return current;
    const latest = current.map(row => row.approvedAt!).sort().at(-1)!;
    // Same-time approvals still require an explicit choice, never array order.
    return current.filter(row => row.approvedAt === latest);
  }
  if (needs.has('resume-source')) {
    if (selection.uploadedResumeId) { if (upload) addOne('resume-source', [upload], selection.uploadedResumeId); }
    else addOne('resume-source', selectResume(activeResumes, selection.resumeId));
  }
  if (needs.has('reviewed-resume')) {
    const selectedJobs = liveJobs.filter(row => valid(row, input.ownerId) && (!selection.targetJobId || row.id === selection.targetJobId));
    if (selectedJobs.length === 1) addOne('reviewed-resume', selectResume(activeResumes.filter(row => row.track === selectedJobs[0]!.track), selection.resumeId));
  }
  if (needs.has('knowledge') && knowledge) addOne('knowledge', [knowledge], undefined, knowledge.empty ? '通用' : 'knowledge');
  if (needs.has('conversation-goal') && goal) addOne('conversation-goal', [goal], selection.goalMessageId);
  if (needs.has('contact') && contact) addOne('contact', [contact], selection.contactId);
  cancelled(input.signal);
  return { context: { ownerId: input.ownerId, profileRevision: ownedProfile?.revision ?? 0, inputs, tools: { ...input.tools } as Partial<Record<CareerTool, 'ready' | 'unavailable' | 'requires_connection'>> }, summaries, snapshots, unavailableSources: unavailableSources.sort() };
}
