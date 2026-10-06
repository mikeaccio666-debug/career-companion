import { describe, expect, it } from 'vitest';
import { parseCandidateProfileV2Patch, parseAssistantProfileRequest, parseAssistantProfileResponse, parseAssistantReadRequest } from '../src/index.ts';

const id = '10000000-0000-4000-8000-000000000001';
const patch = { schemaVersion: 2, expectedRevision: '7', expectedDeletionEpoch: '1', fields: { summary: '  Updated by owner  ' } };
const request = () => ({ kind: 'assistant/profile-v1', id, operation: 'PATCH_PROFILE_V2', patch });

describe('shared Profile patch and dedicated assistant write boundary', () => {
  it('retains server normalization and permits a single section without unrelated required fields', () => {
    expect(parseCandidateProfileV2Patch(patch)).toEqual({ ...patch, fields: { summary: 'Updated by owner' } });
    expect(parseAssistantProfileRequest(request())).toEqual({ ...request(), patch: { ...patch, fields: { summary: 'Updated by owner' } } });
  });
  it('requires both optimistic-concurrency tokens and rejects caller authority', () => {
    for (const bad of [
      { ...patch, expectedRevision: undefined }, { ...patch, expectedDeletionEpoch: undefined },
      { ...patch, expectedRevision: '07' }, { ...patch, ownerId: id },
      // identity.pronouns 自 argoland #535 起是正经路径；仍要拒的是闭集之外的路径。
      { ...patch, fields: { 'identity.ssn': 'inferred' } },
      { ...patch, fields: { summary: 'x'.repeat(4001) } },
    ]) expect(parseAssistantProfileRequest({ ...request(), patch: bad })).toBeNull();
    expect(parseAssistantProfileRequest({ ...request(), url: 'https://foreign.example.test' })).toBeNull();
    expect(parseAssistantReadRequest({ ...request(), kind: 'assistant/read-v1' })).toBeNull();
  });
  it('does not admit collection metadata, duplicate ids, or invalid work authorization answers', () => {
    const skill = { id, name: 'TypeScript', categories: ['TECHNICAL'], confirmFields: ['name', 'categories'] };
    for (const extra of [
      { skills: [skill, skill] }, { skills: [{ ...skill, authority: 'USER_CONFIRMED' }] },
      { workAuthorizations: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'INFERRED', confirmFields: [] }] },
    ]) expect(parseCandidateProfileV2Patch({ ...patch, ...extra })).toBeNull();
  });
  it('keeps read operations compatible inside the dedicated protocol without extending the readonly protocol', () => {
    expect(parseAssistantProfileRequest({ kind: 'assistant/profile-v1', id, operation: 'PROFILE_V2' })).not.toBeNull();
    expect(parseAssistantProfileRequest({ kind: 'assistant/profile-v1', id, operation: 'PROFILE_V2', patch })).toBeNull();
    expect(parseAssistantProfileRequest({ ...request(), kind: 'assistant/read-v1' })).toBeNull();
  });
  it('returns only closed write outcomes and no arbitrary server messages', () => {
    const result = { kind: 'assistant/profile-result-v1', id, operation: 'PATCH_PROFILE_V2', ok: false, code: 'SAVE_UNCERTAIN' };
    expect(parseAssistantProfileResponse(result)).toEqual(result);
    expect(parseAssistantProfileResponse({ ...result, message: 'private provider detail' })).toBeNull();
    expect(parseAssistantProfileResponse({ ...result, code: 'SERVER_STRING' })).toBeNull();
    expect(parseAssistantProfileResponse({ ...result, ok: true, value: {} })).toBeNull();
  });
});

it('does not disguise unexpected validator exceptions as invalid user input', () => {
  const fault = new Error('VALIDATOR_BUG');
  const raw = { schemaVersion: 2, expectedRevision: '1', expectedDeletionEpoch: '0', fields: { summary: 'Valid' } };
  Object.defineProperty(raw, 'schemaVersion', { get() { throw fault; } });
  expect(() => parseCandidateProfileV2Patch(raw)).toThrow(fault);
  expect(parseCandidateProfileV2Patch({ schemaVersion: 2 })).toBeNull();
});
