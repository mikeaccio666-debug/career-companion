import test from 'node:test';
import assert from 'node:assert/strict';
import { careerSkill, prepareCareerRun, type CareerSkillId } from '@companion/career-core';
import { buildCareerRunContext, careerInputSnapshot, type CareerRunPorts, type OwnedCareerApplication, type OwnedCareerInput, type OwnedCareerProfile } from '../src/career-run-context.ts';

const ownerId = 'fictional-owner';
const record = (id: string, extra: Partial<OwnedCareerInput> = {}): OwnedCareerInput => ({ id, revision: 3, ownerId, state: 'current', normalSummary: `Fictional summary for ${id}.`, ...extra });
const profile = (confirmed = true): OwnedCareerProfile => ({ ...record('fictional-profile'), confirmed: { degree: confirmed, graduation: confirmed, roleFamily: confirmed } });
const job = (id: string, extra: Partial<OwnedCareerApplication> = {}): OwnedCareerApplication => ({ ...record(id), stage: 'saved', track: 'fictional-track-a', ...extra });
const toolsFor = (id: CareerSkillId) => Object.fromEntries(careerSkill(id).tools.map(tool => [tool, 'ready'])) as Parameters<typeof buildCareerRunContext>[0]['tools'];
const build = (skillId: CareerSkillId, ports: CareerRunPorts, extra: Partial<Parameters<typeof buildCareerRunContext>[0]> = {}) => buildCareerRunContext({ ownerId, skillId, ports, tools: toolsFor(skillId), ...extra });

test('missing ports are unavailable and do not mint an initial profile or empty knowledge batch', async () => {
  const result = await build('role-exploration', {});
  assert.equal(result.context.profileRevision, 0);
  assert.deepEqual(result.context.inputs, []);
  assert.deepEqual(result.unavailableSources, ['listApplications', 'readKnowledgeAccess', 'readProfile']);
  const prepared = prepareCareerRun('role-exploration', result.context);
  assert.equal(prepared.state, 'blocked');
  if (prepared.state === 'blocked') assert.ok(prepared.reasons.includes('missing_input:knowledge'));
});
test('owned collections freeze into one deterministic reference with an actual member list', async () => {
  const rows = [job('fictional-job-a'), job('fictional-job-b'), job('fictional-job-c')];
  const ports: CareerRunPorts = { readProfile: async scope => { assert.equal(scope.ownerId, ownerId); return profile(); }, listApplications: async () => rows, readKnowledgeAccess: async () => ({ ...record('fictional-knowledge-access'), empty: true }) };
  const first = await build('role-exploration', ports), second = await build('role-exploration', { ...ports, listApplications: async () => [...rows].reverse() });
  const jobs = first.context.inputs.filter(ref => ref.input === 'current-jobs');
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0]!.id.startsWith('snap_'));
  assert.equal(jobs[0]!.id, second.context.inputs.find(ref => ref.input === 'current-jobs')!.id);
  assert.equal(first.snapshots.find(snapshot => snapshot.input === 'current-jobs')!.members.length, 3);
  assert.equal(first.summaries.find(summary => summary.input === 'knowledge')!.label, '通用');
  assert.equal(prepareCareerRun('role-exploration', first.context).state, 'ready_for_draft');
});
test('foreign, stale, closed and malformed stages cannot satisfy the three-job threshold', async () => {
  const badRows = [job('fictional-job-a'), job('fictional-job-b'), job('foreign-job', { ownerId: 'another-owner' }), job('closed-job', { stage: 'closed' }), job('stale-job', { state: 'stale' }), job('bad-stage', { stage: 'rejected' as any })];
  const result = await build('role-exploration', { readProfile: async () => profile(), listApplications: async () => badRows, readKnowledgeAccess: async () => ({ ...record('fictional-knowledge'), empty: false }) });
  assert.equal(result.context.inputs.some(ref => ref.input === 'current-jobs'), false);
  const prepared = prepareCareerRun('role-exploration', result.context);
  assert.equal(prepared.state, 'blocked');
  if (prepared.state === 'blocked') assert.ok(prepared.reasons.includes('missing_input:current-jobs'));
  assert.equal(careerInputSnapshot(ownerId, 'current-jobs', [record('duplicate'), record('duplicate')]), undefined);
});
test('confirmed profile requires the three real confirmations, and reviewed resume matches the selected track', async () => {
  const ports: CareerRunPorts = { readProfile: async () => profile(false), listApplications: async () => [job('fictional-job')], listResumeVersions: async () => [
    { ...record('fictional-resume-a'), status: 'active', track: 'fictional-track-a' }, { ...record('fictional-resume-b'), status: 'active', track: 'fictional-track-b' }, { ...record('foreign-resume'), ownerId: 'another-owner', status: 'active', track: 'fictional-track-a' },
  ] };
  const blocked = await build('application-preparation', ports, { selection: { targetJobId: 'fictional-job' } });
  assert.equal(blocked.context.inputs.some(ref => ref.input === 'confirmed-profile'), false);
  assert.equal(blocked.context.inputs.find(ref => ref.input === 'reviewed-resume')!.id, 'fictional-resume-a');
  const ready = await build('application-preparation', { ...ports, readProfile: async () => profile() }, { selection: { targetJobId: 'fictional-job' } });
  assert.equal(prepareCareerRun('application-preparation', ready.context).state, 'ready_for_draft');
});
test('ambiguous target jobs remain ambiguous and cannot arbitrarily choose a matching resume', async () => {
  const result = await build('application-preparation', { readProfile: async () => profile(), listApplications: async () => [job('fictional-job-a'), job('fictional-job-b')], listResumeVersions: async () => [{ ...record('fictional-resume'), status: 'active', track: 'fictional-track-a' }] });
  const prepared = prepareCareerRun('application-preparation', result.context);
  assert.equal(prepared.state, 'blocked');
  if (prepared.state === 'blocked') {
    assert.ok(prepared.reasons.includes('ambiguous_input:target-job'));
    assert.ok(prepared.reasons.includes('missing_input:reviewed-resume'));
  }
});
test('skill gaps need three actual practice records and never count project or withdrawn records', async () => {
  const ports: CareerRunPorts = { readProfile: async () => profile(), listTargets: async () => [{ ...record('fictional-target'), status: 'exploring' }], listEvidence: async () => [
    { ...record('practice-a'), kind: 'practice_review' }, { ...record('practice-b'), kind: 'practice_review' }, { ...record('project-c'), kind: 'project' }, { ...record('withdrawn-practice'), state: 'withdrawn', kind: 'practice_review' },
  ] };
  const missing = await build('skill-drill', ports);
  assert.equal(missing.context.inputs.some(ref => ref.input === 'skill-gaps'), false);
  const ready = await build('skill-drill', { ...ports, listEvidence: async () => [{ ...record('practice-a'), kind: 'practice_review' }, { ...record('practice-b'), kind: 'practice_review' }, { ...record('practice-c'), kind: 'practice_review' }] });
  assert.equal(ready.context.inputs.filter(ref => ref.input === 'skill-gaps').length, 1);
  assert.equal(prepareCareerRun('skill-drill', ready.context).state, 'ready_for_draft');
});
test('knowledge revocation and cancellation remain factual, without fallback rows', async () => {
  const revoked = await build('interview-brief', { readProfile: async () => profile(), listApplications: async () => [job('fictional-job')], readKnowledgeAccess: async () => ({ ...record('fictional-knowledge'), state: 'withdrawn', empty: false }) });
  assert.equal(revoked.context.inputs.some(ref => ref.input === 'knowledge'), false);
  const controller = new AbortController();
  await assert.rejects(build('career-intake', { readProfile: async scope => { assert.equal(scope.signal, controller.signal); controller.abort(); return profile(); } }, { signal: controller.signal }), { code: 'CAREER_PREPARATION_CANCELLED' });
});

test('latest active resume uses genuine approval time independently of list order, preserves explicit older choices and excludes foreign or archived records', async()=>{
 const old={...record('older'),status:'active' as const,track:'fictional-track-a',approvedAt:'2026-10-01T00:00:00.000Z'};
 const latest={...record('latest'),status:'active' as const,track:'fictional-track-a',approvedAt:'2026-10-02T00:00:00.000Z'};
 const rows=[old,latest,{...latest,id:'foreign',ownerId:'other-owner',approvedAt:'2026-10-07T00:00:00.000Z'},{...latest,id:'archived',status:'archived' as const,approvedAt:'2026-10-08T00:00:00.000Z'}];
 const ports:CareerRunPorts={readProfile:async()=>profile(),listResumeVersions:async()=>rows};
 for(const list of [rows,[...rows].reverse()]){const result=await build('resume-revision',{...ports,listResumeVersions:async()=>list});assert.equal(result.context.inputs.find(r=>r.input==='resume-source')!.id,'latest');}
 const selected=await build('resume-revision',ports,{selection:{resumeId:'older'}});assert.equal(selected.context.inputs.find(r=>r.input==='resume-source')!.id,'older');
 for(const id of ['foreign','archived','absent'])assert.equal((await build('resume-revision',ports,{selection:{resumeId:id}})).context.inputs.some(r=>r.input==='resume-source'),false);
});
test('equal-time or unproven resume recency remains ambiguous until a real version is explicitly selected',async()=>{
 const a={...record('a'),status:'active' as const,track:'fictional-track-a',approvedAt:'2026-10-02T00:00:00.000Z'},b={...a,id:'b'};
 for(const rows of [[a,b],[a,{...b,approvedAt:undefined}],[a,{...b,approvedAt:'invented-date'}]]){
  const result=await build('resume-revision',{listResumeVersions:async()=>rows});const plan=prepareCareerRun('resume-revision',result.context);assert.equal(plan.state,'blocked');if(plan.state==='blocked')assert(plan.reasons.includes('ambiguous_input:resume-source'));
 }
});
test('reviewed resume selects the latest actual approval within the selected job track and does not switch an explicit mismatching version',async()=>{
 const rows=[{...record('older-a'),status:'active' as const,track:'fictional-track-a',approvedAt:'2026-10-01T00:00:00.000Z'},{...record('latest-a'),status:'active' as const,track:'fictional-track-a',approvedAt:'2026-10-02T00:00:00.000Z'},{...record('latest-b'),status:'active' as const,track:'fictional-track-b',approvedAt:'2026-10-08T00:00:00.000Z'}];
 const ports:CareerRunPorts={readProfile:async()=>profile(),listApplications:async()=>[job('job-a')],listResumeVersions:async()=>rows};
 const result=await build('application-preparation',ports,{selection:{targetJobId:'job-a'}});assert.equal(result.context.inputs.find(r=>r.input==='reviewed-resume')!.id,'latest-a');
 const explicit=await build('application-preparation',ports,{selection:{targetJobId:'job-a',resumeId:'older-a'}});assert.equal(explicit.context.inputs.find(r=>r.input==='reviewed-resume')!.id,'older-a');
 const wrong=await build('application-preparation',ports,{selection:{targetJobId:'job-a',resumeId:'latest-b'}});assert.equal(wrong.context.inputs.some(r=>r.input==='reviewed-resume'),false);
});
