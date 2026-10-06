import { describe, expect, it } from 'vitest';
import { parseApplicationQuestionBatchV1, parseApplicationQuestionResultV1, type ApplicationQuestionBatchV1 } from '../src/applicationQuestionCandidates.ts';
const uuid = '00000000-0000-4000-8000-000000000001';
const request: ApplicationQuestionBatchV1 = { schemaVersion: 1, requestId: uuid,
  context: { extensionInstallId: uuid, missionId: uuid, missionRevision: '1', canonicalJobId: uuid, applicationBundleVersion: '1', applicationTargetRevision: '1', pageId: 'page-1', pageGeneration: '1' },
  questions: [{ questionId: 'q1', text: 'Which language?', controlType: 'SINGLE_CHOICE', required: true, options: [{ optionId: 'ts', text: 'TypeScript' }] }] };
const response = () => ({ schemaVersion: 1, ok: true, requestId: uuid, context: request.context, persisted: false, deliveryAuthorized: false,
  candidates: [{ questionId: 'q1', disposition: 'REVIEW_REQUIRED', reasonCode: 'EVIDENCE_BOUND', answer: { kind: 'CHOICES', optionIds: ['ts'] }, confidence: 'HIGH',
    provenance: [{ evidenceId: 'e1', source: 'PROFILE', sourceId: uuid, sourceRevision: '1' }] }] });
describe('application question exact ephemeral wire', () => {
  it('accepts bound choice/provenance and stable failure', () => {
    expect(parseApplicationQuestionBatchV1(request)).not.toBeNull();
    expect(parseApplicationQuestionResultV1(response(), request)).not.toBeNull();
    expect(parseApplicationQuestionResultV1({ schemaVersion: 1, ok: false, code: 'QUESTION_CONTEXT_STALE' }, request)).not.toBeNull();
  });
  it.each(['owner', 'html', 'currentValues', 'cookies', 'profile', 'answers'])('rejects extra %s rather than trusting caller material', key => {
    expect(parseApplicationQuestionBatchV1({ ...request, [key]: 'forbidden' })).toBeNull();
  });
  it('rejects unknown controls, duplicate IDs, invalid options/revisions and total text bound', () => {
    for (const change of [{ controlType: 'PASSWORD' }, { options: [] }, { text: ' ' }, { text: '字'.repeat(3_000) }, { options: [...request.questions[0]!.options, ...request.questions[0]!.options] }]) {
      expect(parseApplicationQuestionBatchV1({ ...request, questions: [{ ...request.questions[0], ...change }] })).toBeNull();
    }
    expect(parseApplicationQuestionBatchV1({ ...request, questions: [...request.questions, ...request.questions] })).toBeNull();
    expect(parseApplicationQuestionBatchV1({ ...request, context: { ...request.context, pageGeneration: '0' } })).toBeNull();
  });
  it.each([{ persisted: true }, { deliveryAuthorized: true }, { requestId: '00000000-0000-4000-8000-000000000099' },
    { context: { ...request.context, pageGeneration: '2' } }, { rawQuestion: 'not echoed' }])('refuses a rebound or falsely durable response %o', change => {
    expect(parseApplicationQuestionResultV1({ ...response(), ...change }, request)).toBeNull();
  });
  it('refuses off-list choices, duplicate proofs, wrong source and fake error reasons', () => {
    const r = response(); r.candidates[0]!.answer.optionIds = ['elsewhere']; expect(parseApplicationQuestionResultV1(r, request)).toBeNull();
    const p = response(); p.candidates[0]!.provenance.push(p.candidates[0]!.provenance[0]!); expect(parseApplicationQuestionResultV1(p, request)).toBeNull();
    expect(parseApplicationQuestionResultV1({ schemaVersion: 1, ok: false, code: 'raw provider text' }, request)).toBeNull();
    expect(parseApplicationQuestionResultV1({ schemaVersion: 1, ok: false, code: 'EVIDENCE_BOUND' }, request)).toBeNull();
  });
});
