import { ProviderError } from './errors.ts';
import { lookup } from 'node:dns/promises';
export type Fetch = typeof globalThis.fetch;
export type ResolveHost = (hostname: string) => Promise<{address:string;family:number}[]>;
export class HttpClient {
  constructor(readonly fetch: Fetch, readonly resolveHost: ResolveHost = hostname => lookup(hostname,{all:true})) {}
  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(120_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try { response = await this.fetch(url, { ...init, signal, redirect: 'error' }); }
    catch { throw new ProviderError(signal.aborted ? 'PROVIDER_INTERRUPTED' : 'PROVIDER_UNREACHABLE', signal.aborted ? 'The provider request was interrupted or timed out.' : 'The provider could not be reached.', 502); }
    if (!response.ok) {
      await response.body?.cancel();
      const code = response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH_FAILED' : response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_REJECTED';
      throw new ProviderError(code, code === 'PROVIDER_AUTH_FAILED' ? 'Check the provider credentials and model access.' : code === 'PROVIDER_RATE_LIMIT' ? 'The provider reached its rate or credit limit.' : `The provider rejected the request (HTTP ${response.status}).`, response.status === 429 ? 429 : 502);
    }
    return response;
  }
  async json(url: string | URL, init: RequestInit = {}, maxBytes = 8 * 1024 * 1024): Promise<any> {
    const response = await this.request(url, init);
    try { return JSON.parse(new TextDecoder().decode(await readBytes(response, maxBytes))); }
    catch(error) { if(error instanceof ProviderError)throw error; throw new ProviderError('INVALID_PROVIDER_RESPONSE', 'The provider returned an invalid response.'); }
  }
}
export function jsonPost(body: unknown, key: string, signal?: AbortSignal): RequestInit {
  return {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal};
}
export async function readBytes(response: Response, max = 100 * 1024 * 1024): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > max) { await response.body?.cancel(); throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE','The generated output exceeds the size limit.',413); }
  if(!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks:Uint8Array[]=[];let total=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max)throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE','The generated output exceeds the size limit.',413);chunks.push(value);}
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
// SSE records can cross TCP chunks and contain multi-line data fields.
export async function* readSse(response: Response): AsyncGenerator<any> {
  if(!response.body)throw new ProviderError('INVALID_PROVIDER_RESPONSE','The provider returned no stream.');
  const reader=response.body.getReader();const decoder=new TextDecoder();let pending='';let total=0;
  function parse(record:string){const data=record.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return undefined;try{return JSON.parse(data);}catch{throw new ProviderError('INVALID_PROVIDER_STREAM','The provider returned an invalid stream.');}}
  try {
    while(true){const part=await reader.read();pending+=part.done?decoder.decode():decoder.decode(part.value,{stream:true});total+=part.value?.length??0;if(total>32*1024*1024||pending.length>2*1024*1024)throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE','The response stream exceeded its limit.',413);
      let match:RegExpExecArray|null;while((match=/\r?\n\r?\n/.exec(pending))){const record=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);const value=parse(record);if(value!==undefined)yield value;}if(part.done){if(pending.trim()){const value=parse(pending);if(value!==undefined)yield value;}break;}}
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function waitPoll(ms:number,signal?:AbortSignal){signal?.throwIfAborted();await new Promise<void>((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);reject(new ProviderError('JOB_CANCELLED','The task was cancelled.',409));};signal?.addEventListener('abort',abort,{once:true});});}
