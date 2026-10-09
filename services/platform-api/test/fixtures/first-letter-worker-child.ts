/** Test-only transport guard. Import the real worker entrypoint only after
 * validating disposable infrastructure and replacing outbound model fetch. */
import assert from 'node:assert/strict';
const db=new URL(process.env.PLATFORM_DATABASE_URL!);
assert(['127.0.0.1','localhost','[::1]'].includes(db.hostname));
assert.notEqual(db.port,'5442');
assert.match(db.searchParams.get('options')??'',/^-c search_path=companion_name_[0-9a-f]{32}$/);
assert.match(process.env.PLATFORM_QUEUE_NAME??'',/^fictional-first-letter-start-[0-9a-f-]{36}$/);
assert.equal(process.env.OPENAI_API_KEY,'fictional-loopback-only');
const endpoint=new URL(process.env.FICTIONAL_WORKER_ENDPOINT!);
assert.equal(endpoint.protocol,'http:');assert.equal(endpoint.hostname,'127.0.0.1');
assert(endpoint.port);assert.equal(endpoint.pathname,'/');assert.equal(endpoint.search,'');
const transport=globalThis.fetch;
globalThis.fetch=async(target,init)=>{
 assert.equal(String(target),'https://api.openai.com/v1/responses');
 assert.equal(init?.method,'POST');
 return transport(endpoint,{...init,headers:{'content-type':'application/json'},redirect:'error'});
};
await import('../../src/worker-main.ts');
