import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordId,careerRecordObject,type OnboardingQuestionValues} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {Database} from './database.ts';
import type {PlatformConfig} from './config.ts';
import type {LegalBundle} from './legal-documents.ts';
import type {BackgroundGeneration} from './background-generation.ts';
import type {CompanionPrebirthSafety} from './companion-prebirth-safety.ts';
import {CompanionBirthAnswerSources} from './companion-birth-answer-source.ts';
import {readWelcomeSnapshot,type WelcomeRow} from './companion-welcome-snapshot.ts';
import {ApiError} from './errors.ts';
import {composeFirstLetter, snapshotFirstLetterSettings, type FirstLetterCompositionSettings} from './first-letter-composition.ts';

const unavailable=()=>new ApiError(503,'FIRST_LETTER_SOURCES_UNAVAILABLE','The saved first-letter sources could not be confirmed.');
const required=()=>new ApiError(409,'FIRST_LETTER_TRIGGER_REQUIRED','Choose the saved first-letter path before continuing.');
const FIELDS=Object.freeze(['study','graduation','roles','search_stage'] as const);
type Field=typeof FIELDS[number];
type Fact={readonly [K in Field]:Readonly<{field:K;value:Readonly<OnboardingQuestionValues[K]>;
  sourceRef:Readonly<{kind:'onboarding_answer';answersId:string;sourceDraftId:string;question:K;appliedRevision:number;sourceRevision:number}>;
  source:'user_entered';scope:'birth_o2';verification:'self_reported'}>}[Field];
function session(value:FixedSessionContext):FixedSessionContext{
  try{const s=careerRecordObject(value,['userId','tokenHash']);
    if(typeof s.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(s.tokenHash))throw unavailable();
    return Object.freeze({userId:careerRecordId(s.userId),tokenHash:s.tokenHash});
  }catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
}
const digest=(value:unknown)=>'first_letter_source_'+createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Server-only C1 direct-letter sources and prompt preparation. No letter, task,
 * lease, message, profile mutation or entry completion is created. Missing C6
 * and timeout sources cannot be supplied by a caller or inferred from C2. */
export class FirstLetterSources{
  private readonly birth:CompanionBirthAnswerSources;
  constructor(private readonly db:Database,private readonly config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,
    legal:LegalBundle|null,generations:Pick<BackgroundGeneration,'readSavedCompletedForViewerInTransaction'>,
    private readonly safety:Pick<CompanionPrebirthSafety,'assertCurrentSafetyInTransaction'>){
    this.birth=new CompanionBirthAnswerSources(db,config,legal,generations);
  }
  async readInTransaction(c:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
    const s=session(value),birth=await this.birth.readInTransaction(c,s,signal);
    // Birth reader already holds the same owner lock as welcome/source writers.
    const rows=(await c.query<WelcomeRow>('SELECT * FROM platform_companion_welcome WHERE user_id=$1 AND companion_id=$2 FOR SHARE',
      [s.userId,birth.companionId])).rows;
    if(!rows.length)throw required();
    if(rows.length!==1)throw unavailable();
    const row=rows[0];
    if(row.conversation_id!==birth.conversationId||row.birth_receipt_id!==birth.birthReceiptId)throw unavailable();
    const {state,operation}=await readWelcomeSnapshot(c,this.config.dataCrypto,s.userId,row,true);
    if(state.step!=='C7'||state.choice!=='direct_letter'||!operation||operation.choice!=='direct_letter')throw required();
    await this.safety.assertCurrentSafetyInTransaction(c,s,signal);
    const facts:Fact[]=[],omitted:Field[]=[];
    for(const field of FIELDS){
      const answer=birth.answers.answersPartial[field]!;
      if(answer.kind!=='answered'){omitted.push(field);continue;}
      // Values were deeply frozen by the captured-answer codec. One question
      // is one fact; study subfields cannot inflate the minimum-two count.
      facts.push(Object.freeze({field,value:answer.value,source:'user_entered',scope:'birth_o2',verification:'self_reported',
        sourceRef:Object.freeze({kind:'onboarding_answer',answersId:birth.answers.id,
          sourceDraftId:birth.answers.sourceDraftId,question:field,appliedRevision:answer.appliedRevision,
          sourceRevision:birth.answers.sourceRevision})}) as Fact);
    }
    const language=birth.answers.answersPartial.emotion_language!;
    const content=Object.freeze({kind:'owned_first_letter_sources' as const,scope:'direct_letter_o2' as const,
      ownerId:s.userId,companionId:birth.companionId,conversationId:birth.conversationId,
      trigger:Object.freeze({kind:'direct_letter' as const,welcomeId:state.id,operationId:operation.id,revision:state.revision,
        chosenAt:operation.createdAt,birthReceiptId:birth.birthReceiptId}),
      companion:birth.companion,
      facts:Object.freeze(facts),omittedQuestions:Object.freeze(omitted),
      emotionLanguage:language.kind==='answered'?language.value:null,
      requiredFactReferences:Math.min(2,facts.length),needsMoreFacts:facts.length<2,
      provenance:birth.provenance,
    });
    await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();
    return Object.freeze({...content,sourceId:digest(content)});
  }
  async read(value:FixedSessionContext,signal?:AbortSignal){
    const s=session(value);return this.db.withBoundedTransaction(c=>this.readInTransaction(c,s,signal));
  }
  /** Internal preparation only. Settings come from server release configuration
   * and its local date; no HTTP route accepts them. No model or publication. */
  async prepare(value:FixedSessionContext,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
    const savedSettings=snapshotFirstLetterSettings(settings);
    const snapshot=await this.read(value,signal);
    return composeFirstLetter(snapshot,savedSettings);
  }
  async assertCurrentInTransaction(c:PoolClient,value:FixedSessionContext,expected:unknown,signal?:AbortSignal){
    const s=session(value);let ownerId:string,sourceId:string;
    try{const e=careerRecordObject(expected,['ownerId','sourceId']);ownerId=careerRecordId(e.ownerId);
      if(typeof e.sourceId!=='string'||!/^first_letter_source_[0-9a-f]{64}$/.test(e.sourceId))throw unavailable();
      sourceId=e.sourceId;
    }catch{throw new ApiError(400,'FIRST_LETTER_SOURCE_INPUT_INVALID','Use the current first-letter source coordinates.');}
    if(ownerId!==s.userId)throw new ApiError(404,'NOT_FOUND','The first-letter sources were not found.');
    const current=await this.readInTransaction(c,s,signal);
    if(current.sourceId!==sourceId)throw new ApiError(409,'FIRST_LETTER_SOURCES_CHANGED','Read the current first-letter sources before continuing.');
    return current;
  }
}
export type FirstLetterSourceSnapshot=Awaited<ReturnType<FirstLetterSources['read']>>;
