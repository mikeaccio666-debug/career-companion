import { expect, it } from 'vitest';
import { parseStartApplicationPreparationsRequest } from '../src/applicationPreparations.ts';
const id = '10000000-0000-4000-8000-000000000001';
const base = { clientRequestId: id, expectedRevision: '1', decisions: [{ itemId: id, itemRevision: '1', decision: 'APPLY' }] };
it('accepts explicit existing version or generation track while retaining legacy callers', () => {
  for (const materialPlan of [undefined, { mode: 'USE_EXISTING', trackId: id, resumeVersionId: id, expectedLibraryRevision: '1' },
    { mode: 'GENERATE_FOR_JOB', trackId: id, expectedLibraryRevision: '1' }]) {
    const input = materialPlan ? { ...base, materialPlan } : base;
    expect(parseStartApplicationPreparationsRequest(input)).toEqual(input);
  }
});
it('rejects implicit selection, extra authority, malformed revisions and duplicate decisions', () => {
  for (const materialPlan of [null, {}, { mode:'USE_EXISTING', trackId:id, expectedLibraryRevision:'1' },
    { mode:'GENERATE_FOR_JOB',trackId:id,expectedLibraryRevision:'1',resumeVersionId:id },
    { mode:'USE_EXISTING',trackId:id,resumeVersionId:id,expectedLibraryRevision:'-1' }]) {
    expect(parseStartApplicationPreparationsRequest({...base,materialPlan})).toBeNull();
  }
  expect(parseStartApplicationPreparationsRequest({...base,decisions:[...base.decisions,...base.decisions]})).toBeNull();
  expect(parseStartApplicationPreparationsRequest({...base,ownerId:id})).toBeNull();
});
