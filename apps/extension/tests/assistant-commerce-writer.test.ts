import { describe,expect,it,vi } from 'vitest';
import { parseAssistantCommerceRequest,parseUuid } from '@edaix/contracts';
import { createOwnerCommerce } from '../assistant/features/commerce/owner-commerce';
const ownerId=parseUuid('11111111-1111-4111-8111-111111111111')!,role=parseUuid('22222222-2222-4222-8222-222222222222')!;
const command=parseAssistantCommerceRequest({kind:'assistant/commerce-request-v1',id:ownerId,operation:'JOBS_BATCHES',conversationId:role})!;
const identity={ownerId,generation:1};
function harness(){
  const currentSession=vi.fn(async()=>identity),accessToken=vi.fn(async()=>'synthetic-token'),fetchFn=vi.fn(async()=>new Response(JSON.stringify({schemaVersion:1,batches:[]}),{headers:{'content-type':'application/json'}}));
  return {currentSession,accessToken,fetchFn,port:createOwnerCommerce({enabled:true,apiBase:'https://api.example.test',currentSession,accessToken,fetchFn})};
}
describe('private commerce worker HTTP adapter',()=>{
  it('checks frame admission and owner around fixed authenticated requests',async()=>{
    const h=harness(),admitted=vi.fn(async()=>true);
    expect(await h.port.execute(identity,command,new AbortController().signal,admitted)).toMatchObject({ok:true,operation:'JOBS_BATCHES',value:{batches:[]}});
    expect(h.fetchFn).toHaveBeenCalledWith(`https://api.example.test/api/v1/agent/assistant/jobs/batches?conversationId=${role}`,expect.objectContaining({redirect:'error',credentials:'omit',cache:'no-store'}));
    expect(admitted).toHaveBeenCalledTimes(3);
  });
  it('denies unadmitted frames before token access and discards late owner changes',async()=>{
    const h=harness();
    expect(await h.port.execute(identity,command,new AbortController().signal,async()=>false)).toMatchObject({ok:false,code:'SENDER_REJECTED'});
    expect(h.accessToken).not.toHaveBeenCalled();
    h.currentSession.mockResolvedValueOnce(identity).mockResolvedValueOnce(identity).mockResolvedValueOnce({...identity,generation:2});
    expect(await h.port.execute(identity,command,new AbortController().signal,async()=>true)).toMatchObject({ok:false,code:'OWNER_CHANGED'});
  });
  it('rejects arbitrary paths, client-side free quantities and malformed responses',async()=>{
    expect(parseAssistantCommerceRequest({...command,url:'https://other.example.com'})).toBeNull();
    expect(parseAssistantCommerceRequest({...command,operation:'JOBS_DELIVER',request:{conversationId:role,batchId:ownerId,units:0}})).toBeNull();
    const h=harness();h.fetchFn.mockResolvedValue(new Response(JSON.stringify({schemaVersion:1,batches:[],token:'leak'}),{headers:{'content-type':'application/json'}}));
    expect(await h.port.execute(identity,command,new AbortController().signal,async()=>true)).toMatchObject({ok:false,code:'RESPONSE_MALFORMED'});
  });
});
