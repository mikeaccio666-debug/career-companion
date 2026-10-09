import type {PoolClient} from 'pg';
import type {FixedSessionContext} from './auth.ts';
import type {Database} from './database.ts';
import type {PlatformConfig} from './config.ts';
import type {LegalBundle} from './legal-documents.ts';
import type {BackgroundGeneration} from './background-generation.ts';
import {CompanionBirthAnswerSources} from './companion-birth-answer-source.ts';
import {ApiError} from './errors.ts';

/** Q4-only projection. No private birth answers cross this boundary. */
export class CompanionPlanningSources {
  private readonly answers:CompanionBirthAnswerSources;
  constructor(db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,
    legal:LegalBundle|null,generations:Pick<BackgroundGeneration,'readSavedCompletedForViewerInTransaction'>){
    this.answers=new CompanionBirthAnswerSources(db,config,legal,generations);
  }
  private project(source:Awaited<ReturnType<CompanionBirthAnswerSources['read']>>){
    const q4=source.answers.answersPartial.Q4!;
    return Object.freeze({ownerId:source.ownerId,companionId:source.companionId,revision:1 as const,
      scope:'birth_answers' as const,fifteenMinuteSteps:q4.kind==='answered'&&q4.value==='A',
      provenance:Object.freeze({birthReceiptId:source.birthReceiptId,taskId:source.provenance.taskId,answersId:source.answers.id,
        sourceRevision:source.answers.sourceRevision,sourceReceiptVersion:source.provenance.sourceReceiptVersion,
        proofKind:source.provenance.proofKind,fastTrack:source.answers.fastTrack,questionState:q4.kind}),
    });
  }
  private rethrow(error:unknown):never {
    if(error instanceof ApiError&&error.code==='COMPANION_BIRTH_ANSWERS_UNAVAILABLE')
      throw new ApiError(503,'COMPANION_PLANNING_SOURCE_UNAVAILABLE','The saved planning preference could not be confirmed.');
    throw error;
  }
  async readInTransaction(c:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
    try{return this.project(await this.answers.readInTransaction(c,value,signal));}catch(error){return this.rethrow(error);}
  }
  async read(value:FixedSessionContext,signal?:AbortSignal){
    try{return this.project(await this.answers.read(value,signal));}catch(error){return this.rethrow(error);}
  }
}
