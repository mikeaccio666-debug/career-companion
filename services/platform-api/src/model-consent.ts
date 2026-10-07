import type { PoolClient } from 'pg';
import type { PlatformProviderRuntime, ProviderRequestAdmission, ProviderRequestContext } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import { assertActiveLegal, type LegalBundle } from './legal-documents.ts';
import { ApiError } from './errors.ts';

export interface ModelJobClaim {
  readonly userId: string; readonly jobId: string; readonly generation: number; readonly leaseToken: string;
  readonly authVersion: string; readonly signal?: AbortSignal;
}
const denied = () => new ApiError(403,'TERMS_CONFIRMATION_REQUIRED','Read and confirm the current legal documents before using AI.');

/** Identity is captured by the HTTP controller or claimed worker, never from model/client arguments. */
export class ModelConsent {
  constructor(readonly db: Database, readonly bundle: LegalBundle | null) {}
  private async consent(client: PoolClient, userId: string, signal: AbortSignal): Promise<void> {
    const bundle = await assertActiveLegal(client,this.bundle,signal);
    const result = await client.query('SELECT user_id FROM platform_terms_consents WHERE user_id=$1 AND terms_version=$2 AND content_digest=$3',[userId,bundle.version,bundle.digest]);
    signal.throwIfAborted(); if (!result.rowCount) throw denied();
  }
  forSession(context: FixedSessionContext, parentSignal?: AbortSignal): ProviderRequestAdmission {
    const fixed = Object.freeze({userId:context.userId,tokenHash:context.tokenHash});
    return this.admission(async (client,signal)=>{
      await authorizeFixedSession(client,fixed,signal);
      await this.consent(client,fixed.userId,signal);
      await authorizeFixedSession(client,fixed,signal);
    },parentSignal);
  }
  forJob(context: ModelJobClaim): ProviderRequestAdmission {
    const fixed = Object.freeze({...context});
    return this.admission(async(client,signal)=>{
      // Account -> job -> legal policy matches HTTP/reset ordering. A previous claim
      // cannot acquire a fresh auth version after password reset or owner change.
      const user = await client.query('SELECT auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[fixed.userId]);
      signal.throwIfAborted();
      if (!user.rowCount || String(user.rows[0].auth_version) !== fixed.authVersion) throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
      const authorizeJob=async()=>{
        const job = await client.query(`SELECT id FROM platform_jobs WHERE id=$1 AND user_id=$2 AND generation=$3 AND lease_token=$4
          AND lease_until>clock_timestamp() AND status='running' AND (NOT requires_approval OR EXISTS
          (SELECT 1 FROM platform_approvals a WHERE a.job_id=platform_jobs.id AND a.user_id=platform_jobs.user_id AND a.generation=platform_jobs.generation AND a.status='approved')) FOR UPDATE`,[fixed.jobId,fixed.userId,fixed.generation,fixed.leaseToken]);
        signal.throwIfAborted(); if (!job.rowCount) throw new ApiError(409,'JOB_CANCELLED','The task is no longer authorized.');
      };
      await authorizeJob();
      await this.consent(client,fixed.userId,signal);
      // A row lock cannot freeze clock time. Legal-policy lock waits may outlive
      // the worker lease, so check the exact claim again immediately before start.
      await authorizeJob();
    },fixed.signal);
  }
  private admission(check:(client:PoolClient,signal:AbortSignal)=>Promise<void>,parentSignal?:AbortSignal):ProviderRequestAdmission {
    return async <T>(launch:(signal:AbortSignal)=>Promise<T>,requestSignal?:AbortSignal):Promise<T>=>{
      const cancelled = new AbortController();
      const signal = AbortSignal.any([cancelled.signal,...(parentSignal?[parentSignal]:[]),...(requestSignal?[requestSignal]:[])]);
      let pending:Promise<T>|undefined;
      try {
        const started = await this.db.withBoundedTransaction(async client=>{
          await check(client,signal); signal.throwIfAborted();
          // Invocation is the linearization point. Return a container so async/txn
          // promise assimilation does not await headers or a stream under DB locks.
          pending = Promise.resolve(launch(signal));
          pending.catch(()=>{});
          return {pending};
        });
        const result=await started.pending;signal.throwIfAborted();return result;
      } catch (error) {
        cancelled.abort();
        void pending?.then(value=>{if(value instanceof Response && !value.body?.locked)return value.body?.cancel().catch(()=>{});},()=>{}).catch(()=>{});
        throw error;
      }
    };
  }
}

export function requireRequestAdmission(context:ProviderRequestContext|undefined):ProviderRequestAdmission {
  if(typeof context?.requestAdmission!=='function')throw denied();return context.requestAdmission;
}

/** Actual API/worker runtimes require the trusted callback even for test adapters. */
export function requireModelConsent(runtime:PlatformProviderRuntime):PlatformProviderRuntime {
  async function check(context:ProviderRequestContext|undefined):Promise<void> {
    await requireRequestAdmission(context)(async()=>undefined,context?.signal);
  }
  return {
    capabilities:()=>runtime.capabilities(),
    ...(runtime.captureComfyUITemplate?{captureComfyUITemplate:()=>runtime.captureComfyUITemplate!()}:{}),
    ...(runtime.validateComfyUITemplate?{validateComfyUITemplate:(...args)=>runtime.validateComfyUITemplate!(...args)}:{}),
    async *streamChat(input,context){await check(context); yield* runtime.streamChat(input,context);},
    ...(runtime.streamModelStep?{async *streamModelStep(input,context){await check(context);return yield* runtime.streamModelStep!(input,context);}}:{}),
    async executeJob(input,context){await check(context);return runtime.executeJob(input,context);},
    async createVoiceSession(input,context){await check(context);return runtime.createVoiceSession(input,context);},
    async transcribe(input,context){await check(context);return runtime.transcribe(input,context);},
    async speech(input,context){await check(context);return runtime.speech(input,context);},
  };
}
