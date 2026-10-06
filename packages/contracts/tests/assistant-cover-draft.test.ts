import {expect,it} from 'vitest';
import {parseAssistantCoverDraftRequest,parseAssistantCoverDraftResponse} from '../src/assistantCoverDraft.ts';
const id='10000000-0000-4000-8000-000000000001';
it('bounds private text and requires CAS, idempotency and an explicit generation choice',()=>{
 const base={clientRequestId:id,expectedRevision:0};
 for(const op of [{operation:'SAVE',body:'My own draft'},{operation:'DELETE'},{operation:'GENERATE',unknownRequirementChoice:'GENERATE'}])expect(parseAssistantCoverDraftRequest({...base,...op})).not.toBeNull();
 for(const op of [{operation:'SAVE',body:'界'.repeat(4001)},{operation:'SAVE',body:'\u0000bad'},{operation:'GENERATE'},{operation:'GENERATE',unknownRequirementChoice:'SKIP'},{operation:'DELETE',ownerId:id}])expect(parseAssistantCoverDraftRequest({...base,...op})).toBeNull();
 expect(parseAssistantCoverDraftRequest({...base,expectedRevision:-1,operation:'DELETE'})).toBeNull();
});
it('never presents a private saved draft as attachment authorization',()=>{
 const response={schemaVersion:1,entryId:id,revision:1,draft:{id,body:'Draft',updatedAt:'2026-09-14T00:00:00.000Z',origin:'USER_EDITED',deliveryAuthorized:false}};
 expect(parseAssistantCoverDraftResponse(response)).toEqual(response);
 expect(parseAssistantCoverDraftResponse({...response,draft:{...response.draft,deliveryAuthorized:true}})).toBeNull();
});

it('allows only explicit unreadable-content metadata with a deletable revision',()=>{
 const r={schemaVersion:1,entryId:id,revision:2,draft:null,unavailableReason:'CONTENT_UNAVAILABLE'};
 expect(parseAssistantCoverDraftResponse(r)).toEqual(r);
 expect(parseAssistantCoverDraftResponse({...r,revision:0})).toBeNull();
 expect(parseAssistantCoverDraftResponse({...r,unavailableReason:'raw private error'})).toBeNull();
});
