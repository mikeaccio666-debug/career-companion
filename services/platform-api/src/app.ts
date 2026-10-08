import { ConversationTurns, mapMessage } from './conversation-turns.ts';
import { SseTurnSink } from './turn-sinks.ts';
import { ProjectingTurnSink } from './projecting-turn-sink.ts';
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Conversation, PlatformProviderRuntime, ProviderAttachment, User, VoiceContextSnapshot, VoiceSessionResponse } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER, parseCompanionSafetyQuestionReserveCommand } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { Database } from './database.ts';
import { readConfig, type PlatformConfig } from './config.ts';
import { authorizeFixedSession, checkPassword, fixedRequestSession, getUser, hashPassword, logout, setSession, setSessionCookie } from './auth.ts';
import { AccountActions } from './account-actions.ts';
import { readResourceSession } from './resource-session.ts';
import { KnowledgeSources } from './knowledge-sources.ts';
import { ApiError, identifier, invalid, notFound, object, string } from './errors.ts';
import { createStorage, type BlobStorage, validateUpload } from './storage.ts';
import { JobService, mapApproval, parseJob, publicError, TaskQueue } from './jobs.ts';
import { acquireRuntimeLease, recoverStaleStreams, withVoiceLease } from './runtime-leases.ts';
import { listVoiceRecords, rememberVoiceSession, releaseVoiceSession, saveVoiceRecord } from './voice-history.ts';
import { assertVoiceConversation, readVoiceContext } from './voice-context.ts';
import { createWorkflowTemplate, deleteWorkflowTemplate, listWorkflowTemplates, updateWorkflowTemplate, WORKFLOW_TEMPLATE_BYTES } from './workflow-templates.ts';
import { servePrivateFile } from './private-files.ts';
import { parseArtifactTextQuery } from './artifact-text.ts';
import { configureStaticWeb } from './static-web.ts';
import { configurePlatformHttp } from './http-policy.ts';
import { requireAccountContext } from './account-context.ts';
import { accountUsage } from './chat-usage.ts';
import { RequestLimits, type RequestLimitsOptions, type UserRequestLimitScope, type AnonymousRequestLimitScope, type RequestLimitDecision } from './request-limits.ts';
import { mcpJobInput } from './mcp-connections.ts';
import type { McpTransport } from './mcp-transport-port.ts';
import { GoalPlans } from './goal-plans.ts';
import { GoalPlanProposals } from './goal-plan-proposals.ts';
import { GoalPlanReaders } from './goal-plan-readers.ts';
import { JobOutcomeReviews } from './job-outcome-reviews.ts';
import { OperationsReadiness } from './operations-readiness.ts';
import { AudioTranscriptions, providersWithChatAttachments } from './audio-transcriptions.ts';
import { assertHttpWorkbench, serverConversationInput, serverMessageInput, serverPublicCapabilities } from './student-channel.ts';
import { resolveModelRoute } from './model-routing.ts';
import { StaffAccess } from './staff-access.ts';
import { loadLegalBundle, parseLegalBundle, legalAvailability, publicLegalDocuments, type LegalBundle } from './legal-documents.ts';
import { StudentEntry } from './student-entry.ts';
import { createOnboardingEntry } from './onboarding-entry.ts';
import { CompanionEntry } from './companion-entry.ts';
import { CompanionGenerationQueue } from './companion-generation-queue.ts';
import { createCompanionStudentOnboarding } from './companion-student-onboarding.ts';
import { createCompanionSafetyResources, readCompanionSafetyResourceConfiguration } from './companion-safety-resources.ts';
import { CompanionNameQueue } from './companion-name-queue.ts';
import { companionNameUuid } from './companion-name-safety-protocol.ts';
import { ModelConsent, requireModelConsent } from './model-routing.ts';
import {
  projectPlatformFeatures, projectPublicAccountUsage, projectPublicApproval, projectPublicAudioTranscriptionReceipt,
  projectPublicConversation, projectPublicConversationTaskPage, projectPublicError, projectPublicGoalPlan,
  projectPublicGoalPlanContinueResult, projectPublicGoalPlanList, projectPublicGoalPlanProposalList,
  projectPublicMessage, projectPublicVoiceRecord, projectPublicVoiceSessionResponse, projectPublicWorkflowTemplate, projectPublicJob,
  projectPublicJobOutcomeReviewPage, projectPublicJobOutcomeReviewSaved,
} from './student-projection.ts';

const prefix='/api/platform';
type AuthRequest = FastifyRequest & { platformUser: User };
function mapConversation(row:any):Conversation {return {id:row.id,title:row.title,mode:row.mode,persona:row.persona??undefined,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};}
function passwordInput(value:unknown):string {if(typeof value!=='string'||!value.length||value.length>256)throw invalid('A password of at most 256 characters is required.');return value;}
function params(request:FastifyRequest,key='id'){return identifier((request.params as Record<string,unknown>)[key]);}
function voiceBody(value:unknown,fields:readonly string[]){const data=object(value);if(Object.keys(data).some(key=>!fields.includes(key)))throw invalid('Unsupported voice request field.');return data;}
function accountBody(value:unknown,fields:readonly string[]){const data=object(value);if(Object.keys(data).some(key=>!fields.includes(key)))throw invalid('Unsupported account request field.');return data;}
function staffReadFailure(cause:unknown):never {
  if(cause instanceof ApiError)throw cause;
  throw new ApiError(503,'STAFF_ACCESS_UNAVAILABLE','Staff access could not be verified. Try again later.');
}

export interface AppOptions { legalBundle?:LegalBundle|null; config?:PlatformConfig; db?:Database; runtime?:PlatformProviderRuntime; storage?:BlobStorage; queue?:TaskQueue; enableQueue?:boolean; requestLimits?:RequestLimitsOptions; mcp?:McpTransport; }
export async function buildApp(options:AppOptions={}) {
  const config=options.config??readConfig();
  const present=<T,P>(value:T,project:(value:T)=>P):T|P=>config.workbenchEnabled?value:project(value);
  const db=options.db??new Database(config.databaseUrl,{max:config.databasePoolMax,connectionTimeoutMillis:config.databaseConnectTimeoutMs});
  const bundle=options.legalBundle===undefined?await loadLegalBundle(config.legalBundlePath):parseLegalBundle(options.legalBundle);
  const entry=new StudentEntry(db,config,bundle),modelConsent=new ModelConsent(db,bundle);
  const runtime=requireModelConsent(options.runtime??createProviderRuntime());
  const onboarding=await createOnboardingEntry(db,config,bundle,runtime);
  const companion=new CompanionEntry(db,config,bundle,runtime);
  const safetyResourcesConfiguration=await readCompanionSafetyResourceConfiguration(config);
  const studentOnboarding=await createCompanionStudentOnboarding(db,config,bundle,runtime,companion.generation,safetyResourcesConfiguration.review);
  const safetyResources=await createCompanionSafetyResources(db,config,bundle,studentOnboarding.nameDelivery,safetyResourcesConfiguration);
  const naming=studentOnboarding.naming;
  const storage=options.storage??createStorage(config);
  const jobs=new JobService(db,config,runtime,storage,undefined,options.mcp,bundle);
  const requestLimits=new RequestLimits(db,options.requestLimits);
  const accountActions=new AccountActions(db,config.accountEmail);
  const staff=new StaffAccess(db);
  const knowledge=new KnowledgeSources(db);
  const audioTranscriptions=new AudioTranscriptions(db,storage,runtime);
  const goalPlans=new GoalPlans(db,jobs,runtime);
  const goalPlanProposals=new GoalPlanProposals(db,goalPlans);
  const goalPlanReaders=new GoalPlanReaders(db);
  const conversationTurns=new ConversationTurns({db,runtime,jobs,knowledge,audioTranscriptions,goalPlans,goalPlanProposals,goalPlanReaders});
  const jobOutcomeReviews=new JobOutcomeReviews(db);
  const queue=options.queue??(options.enableQueue===false?undefined:new TaskQueue(jobs));
  const companionQueue=options.enableQueue===false?undefined:new CompanionGenerationQueue(companion);
  const companionNameQueue=options.enableQueue===false?undefined:new CompanionNameQueue(naming);
  const readiness=new OperationsReadiness(db,config,Boolean(queue));
  const app=Fastify({logger:false,bodyLimit:256*1024,requestTimeout:120_000});
  await configurePlatformHttp(app,config);
  await app.register(cookie);
  await app.register(multipart,{limits:{fileSize:20*1024*1024,files:1,fields:5}});
  app.decorateRequest('platformUser',null);
  app.setErrorHandler((cause,request,reply)=>{
    const error=cause as FastifyError;
    if(error instanceof ApiError){reply.code(error.status).send({error:present({code:error.code,message:error.publicMessage},projectPublicError)});return;}
    if(error.code==='FST_REQ_FILE_TOO_LARGE'){reply.code(413).send({error:{code:'FILE_TOO_LARGE',message:'Files must be at most 20 MB.'}});return;}
    if(error.statusCode && error.statusCode<500){reply.code(error.statusCode).send({error:{code:'INVALID_REQUEST',message:'The request could not be processed.'}});return;}
    const safe=publicError(error);reply.code(safe.status).send({error:present({code:safe.code,message:safe.message},projectPublicError)});
  });
  app.addHook('onRequest',async request=>{
    if(['POST','PUT','PATCH','DELETE'].includes(request.method)){
      const origin=request.headers.origin;
      if(!origin || !config.allowedOrigins.has(origin))throw new ApiError(403,'ORIGIN_REJECTED','Use this action from the configured application origin.');
    }
  });
  async function authenticated(request:FastifyRequest){
    const user=await getUser(db,request);
    if(!user)throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
    (request as AuthRequest).platformUser=user;
  }
  const userId=(request:FastifyRequest)=>(request as AuthRequest).platformUser.id;
  async function assertRequestAccount(request:FastifyRequest,uid:string,signal?:AbortSignal){
    signal?.throwIfAborted();const current=await getUser(db,request);
    if(!current||current.id!==uid)throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
    requireAccountContext(request,current.id);signal?.throwIfAborted();
  }
  function enforceLimit(decision:RequestLimitDecision,reply:FastifyReply){
    if(decision.allowed)return;
    reply.header('Retry-After',String(decision.retryAfterSeconds));
    throw new ApiError(429,'REQUEST_LIMIT_REACHED','Too many requests. Try again after the indicated wait.');
  }
  const authenticatedLimit=(scope:UserRequestLimitScope)=>async(request:FastifyRequest,reply:FastifyReply)=>{
    enforceLimit(await requestLimits.consumeUser(userId(request),scope),reply);
  };
  const anonymousLimit=(scope:AnonymousRequestLimitScope)=>async(request:FastifyRequest,reply:FastifyReply)=>{
    // Socket address only: cookies and untrusted forwarding headers do not establish identity.
    enforceLimit(await requestLimits.consumeAnonymous(request.raw.socket.remoteAddress??'',scope),reply);
  };
  async function verifiedAccount(request:FastifyRequest){
    if(config.requireVerifiedEmail && !(request as AuthRequest).platformUser.emailVerified)throw new ApiError(403,'EMAIL_VERIFICATION_REQUIRED','Verify your email to use the workspace.');
  }
  const accountContext=(allowFileQuery=false)=>async(request:FastifyRequest)=>requireAccountContext(request,userId(request),allowFileQuery);
  const secured=(scope:UserRequestLimitScope,allowFileQuery=false)=>({preHandler:[authenticated,accountContext(allowFileQuery),verifiedAccount,authenticatedLimit(scope)]});
  const limitedAccount={preHandler:[authenticated,accountContext(),authenticatedLimit('control')]};
  const secure=secured('api'),control=secured('control'),secureFile=secured('api',true);
  function requestSignal(request:FastifyRequest,reply:FastifyReply){
    const controller=new AbortController();
    const abort=()=>{if(!reply.raw.writableFinished)controller.abort();};
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    if(request.raw.aborted||reply.raw.destroyed)abort();
    return {signal:controller.signal,dispose:()=>{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort);}};
  }

  app.get(`${prefix}/live`,async(_request,reply)=>{reply.header('Cache-Control','no-store');return {ok:true};});
  app.get(`${prefix}/ready`,async(_request,reply)=>{reply.header('Cache-Control','no-store');const result=await readiness.readiness();if(!result.ok)reply.code(503);return result;});
  app.get(`${prefix}/execution-ready`,async(_request,reply)=>{reply.header('Cache-Control','no-store');const result=await readiness.executionReadiness();if(!result.ok)reply.code(503);return result;});
  app.get(`${prefix}/health`,async(_request,reply)=>{reply.header('Cache-Control','no-store');const result=await readiness.health();if(!result.ok)reply.code(503);return result;});
  app.get(`${prefix}/features`,{preHandler:anonymousLimit('public')},async()=>projectPlatformFeatures({workbench:config.workbenchEnabled,providerDetails:config.exposeProviderDetails}));
  app.get(`${prefix}/capabilities`,{preHandler:anonymousLimit('public')},async()=>serverPublicCapabilities(config,runtime,config.mcp?.entries.length?jobs.mcp.capability():undefined));
  app.get(`${prefix}/capabilities/details`,secure,async(request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const query=object(request.query);
    if(Object.keys(query).some(key=>key!=='orgId'))throw invalid('Use only the organization context for provider diagnostics.');
    const cancellation=requestSignal(request,reply),session=fixedRequestSession(request,userId(request));
    try{
      const orgId=query.orgId===undefined?undefined:identifier(query.orgId);
      if(!config.exposeProviderDetails){
        await staff.recordDeniedAccess(session,orgId,'provider_details_viewed','feature_disabled',cancellation.signal);
        throw new ApiError(403,'PROVIDER_DETAILS_DISABLED','Provider diagnostics are disabled on this server.');
      }
      if(query.orgId===undefined)return await staff.denyMissingOrganization(session,'provider_details_viewed',cancellation.signal);
      return await staff.readWithAccess(session,orgId,
      {roles:['ops','org_admin'],action:'provider_details_viewed'},async()=>{
        const providers=[...providersWithChatAttachments(runtime).filter(provider=>provider.id!=='mcp'),...(config.mcp?.entries.length?[jobs.mcp.capability()]:[])];
        return {value:{providers},recordCount:providers.length};
      },cancellation.signal);
    }catch(cause){staffReadFailure(cause);}finally{cancellation.dispose();}
  });
  app.get(`${prefix}/staff/orgs/:id`,secure,async(request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(Object.keys(object(request.query)).length)throw invalid('Organization access does not accept policy overrides.');
    const cancellation=requestSignal(request,reply);
    try{return {organization:await staff.getOrganization(fixedRequestSession(request,userId(request)),params(request),cancellation.signal)};}
    catch(cause){staffReadFailure(cause);}finally{cancellation.dispose();}
  });
  app.get(`${prefix}/staff/orgs/:id/members`,secure,async(request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(Object.keys(object(request.query)).length)throw invalid('Staff membership access does not accept policy overrides.');
    const cancellation=requestSignal(request,reply);
    try{return {memberships:await staff.listMembers(fixedRequestSession(request,userId(request)),params(request),cancellation.signal)};}
    catch(cause){staffReadFailure(cause);}finally{cancellation.dispose();}
  });
  app.get(`${prefix}/auth/options`,{preHandler:anonymousLimit('public')},async(_request,reply)=>{reply.header('Cache-Control','private, no-store');return {emailActionsEnabled:Boolean(config.accountEmail),requireVerifiedEmail:config.requireVerifiedEmail,requireInvite:config.requireInvite,legal:legalAvailability(await entry.availableBundle())};});
  app.get(`${prefix}/auth/legal-documents`,{preHandler:anonymousLimit('public')},async(_request,reply)=>{reply.header('Cache-Control','no-store');return publicLegalDocuments(await entry.availableBundle());});
  app.get(`${prefix}/auth/consent`,limitedAccount,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {consent:await entry.status(fixedRequestSession(request,userId(request)),cancellation.signal)};}finally{cancellation.dispose();}
  });
  app.post(`${prefix}/auth/consent`,limitedAccount,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {consent:await entry.accept(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}finally{cancellation.dispose();}
  });
  app.get(`${prefix}/onboarding`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {entry:await onboarding.read(fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.patch(`${prefix}/onboarding`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {result:await onboarding.save(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/onboarding/safety/retry`,secure,async(request,reply)=>{
    if(Object.keys(object(request.body)).length)throw invalid('Safety retry does not accept classifier inputs.');
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {entry:await onboarding.retrySafety(fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/companion/drafts/current`,secure,async(request,reply)=>{
    if(Object.keys(object(request.query)).length)throw invalid('Companion progress is scoped to the current account.');
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {entry:await companion.read(fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/drafts`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{const result=await companion.accept(fixedRequestSession(request,userId(request)),request.body,cancellation.signal);reply.code(202);return result;}
    finally{cancellation.dispose();}
  });
  // Internal transport only. Raw acceptance has its own durable lifetime;
  // observation does not classify, dispatch, apply or repair saved evidence.
  const namingReadSecure={preHandler:[...secure.preHandler,async(request:FastifyRequest)=>{
    const origin=request.headers.origin;
    if(origin!==undefined&&!config.allowedOrigins.has(origin))throw new ApiError(403,'ORIGIN_REJECTED','Use this action from the configured application origin.');
  }]};
  function namingQuery(request:FastifyRequest){
    if(Object.keys(request.query as Record<string,unknown>).length)throw invalid('Naming reads and submissions do not accept query authority.');
  }
  app.post(`${prefix}/companion/naming/submissions`,secure,async(request,reply)=>{
    namingQuery(request);
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{
      const accepted=await naming.accept(fixedRequestSession(request,userId(request)),request.body,cancellation.signal);
      // Optional post-COMMIT notification only; the independent outbox worker
      // remains the executor even after this HTTP connection disappears.
      if(companionNameQueue)void companionNameQueue.dispatch().catch(()=>{});
      reply.code(202);return accepted;
    }finally{cancellation.dispose();}
  });
  app.get(`${prefix}/companion/naming`,namingReadSecure,async(request,reply)=>{
    namingQuery(request);
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {state:await naming.read(fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/companion/naming/submissions/:operationId`,namingReadSecure,async(request,reply)=>{
    namingQuery(request);
    const operationId=companionNameUuid((request.params as Record<string,unknown>).operationId);
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {accepted:await naming.readOperation(fixedRequestSession(request,userId(request)),operationId,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/companion/journey`,namingReadSecure,async(request,reply)=>{
    namingQuery(request);
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {journey:await studentOnboarding.read(fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/journey/seal`,secure,async(request,reply)=>{
    namingQuery(request);
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {saved:await studentOnboarding.select(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/companion/journey/seal/:taskId/operations/:operationId`,namingReadSecure,async(request,reply)=>{
    namingQuery(request);
    const parameters=request.params as Record<string,unknown>;
    const input={taskId:companionNameUuid(parameters.taskId),operationId:companionNameUuid(parameters.operationId)};
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {saved:await studentOnboarding.readSelectionOperation(fixedRequestSession(request,userId(request)),input,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/journey/name-preparation`,secure,async(request,reply)=>{
    namingQuery(request);
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {accepted:await studentOnboarding.resumeNamePreparation(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  // Fixed resources and receipt declarations do not consume ordinary API quota or depend on current terms/provider availability.
  const resourceAccess={preHandler:[authenticated,accountContext()]};
  function resourceTarget(request:FastifyRequest){
    const parameters=request.params as Record<string,unknown>;
    if(parameters.sourceKind!=='onboarding'&&parameters.sourceKind!=='companion_name')throw invalid('Use an actual support resource source.');
    return {sourceKind:parameters.sourceKind,publicationId:companionNameUuid(parameters.publicationId)};
  }
  app.get(`${prefix}/companion/support`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {index:await safetyResources.resources.readIndex(fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/support/publications`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {publication:await safetyResources.resources.publish(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/support/publications/recovery`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {publication:await safetyResources.resources.recover(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/companion/support/:sourceKind/:publicationId`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const target=resourceTarget(request),cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {state:await safetyResources.resources.read(fixedRequestSession(request,userId(request)),target,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/support/body`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {projection:await safetyResources.resources.readBody(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/support/actions`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {result:await safetyResources.resources.act(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/companion/support/questions/:sourceKind/:publicationId`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const target=resourceTarget(request),cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {state:await safetyResources.questionDelivery.read(fixedRequestSession(request,userId(request)),target,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/support/questions/reservations`,resourceAccess,async(request,reply)=>{
    namingQuery(request);
    // The public source-aware contract is mandatory here. The internal 047
    // service retains its historic name-only input for authenticated replay.
    let input;
    try{input=parseCompanionSafetyQuestionReserveCommand(request.body);}
    catch{throw invalid('Use an actual support source and question reservation.');}
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {reservation:await safetyResources.questionDelivery.reserve(fixedRequestSession(request,userId(request)),input,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/support/questions/claims`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {claim:await safetyResources.questionDelivery.claim(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/companion/support/questions/presentations`,resourceAccess,async(request,reply)=>{
    namingQuery(request);const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {presentation:await safetyResources.questionDelivery.present(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/onboarding/safety`,resourceAccess,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {followup:await onboarding.resources(fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/onboarding/safety`,resourceAccess,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);reply.header('Cache-Control','private, no-store');
    try{return {result:await onboarding.followup.act(fixedRequestSession(request,userId(request)),request.body,cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/auth/register`,{preHandler:anonymousLimit('auth-register')},async(request,reply)=>{
    const cancellation=requestSignal(request,reply);
    try{const result=await entry.register(request.body,cancellation.signal);setSessionCookie(config,reply,result.session);reply.code(201).header('Cache-Control','private, no-store');return {user:result.user};}finally{cancellation.dispose();}
  });
  app.post(`${prefix}/auth/login`,{preHandler:anonymousLimit('auth-login')},async(request,reply)=>{
    const data=object(request.body),email=string(data.email,'email',254).toLowerCase(),password=passwordInput(data.password);
    const result=await db.query('SELECT * FROM platform_users WHERE email=$1',[email]);
    const row=result.rows[0];
    const valid=await checkPassword(password,row?.password_hash??'scrypt:00000000000000000000000000000000:'+Buffer.alloc(64).toString('hex'));
    if(!row||!valid)throw new ApiError(401,'INVALID_CREDENTIALS','Email or password is incorrect.');
    await setSession(db,config,reply,row.id,row.auth_version);return {user:{id:row.id,email:row.email,name:row.name,emailVerified:row.email_verified_at!==null}};
  });
  app.post(`${prefix}/auth/logout`,limitedAccount,async(request,reply)=>{await logout(db,request,reply);return {ok:true};});
  app.get(`${prefix}/auth/me`,{preHandler:[authenticated,authenticatedLimit('api')]},async request=>({user:(request as AuthRequest).platformUser}));
  // A hard refresh must be able to establish the real cookie owner for saved
  // support resources even when ordinary workspace admission is unavailable.
  app.get(`${prefix}/auth/resource-session`,{
    onRequest:async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      const origin=request.headers.origin;
      if(origin!==undefined&&!config.allowedOrigins.has(origin))throw new ApiError(403,'ORIGIN_REJECTED','Use this action from the configured application origin.');
      if(Object.keys(request.query as Record<string,unknown>).length)throw invalid('Resource session observation does not accept query authority.');
    },preHandler:authenticated,
  },async(request,reply)=>{
    if(request.headers[PLATFORM_ACCOUNT_HEADER]!==undefined)requireAccountContext(request,userId(request));
    const cancellation=requestSignal(request,reply);
    try{return {scope:'support_resources',user:await readResourceSession(db,fixedRequestSession(request,userId(request)),cancellation.signal)};}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/auth/password-reset/request`,{preHandler:anonymousLimit('auth-email-request')},async(request,reply)=>{
    const data=accountBody(request.body,['email']),email=string(data.email,'email',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw invalid('Use a valid email.');
    await accountActions.requestPasswordReset(email);reply.code(202);return {accepted:true};
  });
  app.post(`${prefix}/auth/password-reset/complete`,{preHandler:anonymousLimit('auth-email-consume')},async(request,reply)=>{
    const data=accountBody(request.body,['token','password']);
    await accountActions.consume('password-reset',string(data.token,'token',128),typeof data.password==='string'?data.password:undefined);
    reply.clearCookie('companion_session',{path:'/',httpOnly:true,sameSite:'lax',secure:config.secureCookies});return {ok:true};
  });
  app.post(`${prefix}/auth/email-verification/request`,limitedAccount,async(request,reply)=>{
    accountBody(request.body,[]);await accountActions.requestEmailVerification(userId(request));reply.code(202);return {accepted:true};
  });
  app.post(`${prefix}/auth/email-verification/complete`,limitedAccount,async(request)=>{
    const data=accountBody(request.body,['token']);
    await accountActions.consume('verify-email',string(data.token,'token',128),undefined,userId(request));
    const user=await getUser(db,request);if(!user)throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');return {user};
  });
  app.get(`${prefix}/usage`,secure,async request=>{
    if(Object.keys(request.query as Record<string,unknown>).length)throw invalid('Usage is scoped to the signed-in account and current UTC month.');
    return {usage:present(await accountUsage(db,userId(request)),projectPublicAccountUsage)};
  });

  app.get(`${prefix}/workflow-templates`,secure,async request=>({templates:(await listWorkflowTemplates(db,userId(request))).map(template=>present(template,projectPublicWorkflowTemplate))}));
  app.post(`${prefix}/workflow-templates`,{...secure,bodyLimit:WORKFLOW_TEMPLATE_BYTES},async(request,reply)=>{assertHttpWorkbench(config);const template=await createWorkflowTemplate(db,userId(request),request.body);reply.code(201);return {template:present(template,projectPublicWorkflowTemplate)};});
  app.put(`${prefix}/workflow-templates/:id`,{...secure,bodyLimit:WORKFLOW_TEMPLATE_BYTES},async request=>{const id=params(request);if(!config.workbenchEnabled&&!(await db.query('SELECT id FROM platform_workflow_templates WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[id,userId(request)])).rowCount)throw notFound();assertHttpWorkbench(config);return {template:present(await updateWorkflowTemplate(db,userId(request),id,request.body),projectPublicWorkflowTemplate)};});
  app.delete(`${prefix}/workflow-templates/:id`,secure,async request=>{await deleteWorkflowTemplate(db,userId(request),params(request));return {ok:true};});

  app.get(`${prefix}/conversations`,secure,async request=>{
    const result=await db.query('SELECT * FROM platform_conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100',[userId(request)]);return {conversations:result.rows.map(row=>present(mapConversation(row),projectPublicConversation))};
  });
  app.post(`${prefix}/conversations`,secure,async(request,reply)=>{
    const data=serverConversationInput(config,request.body),id=randomUUID();
    const result=await db.query('INSERT INTO platform_conversations(id,user_id,title,mode,persona) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,userId(request),data.title,data.mode,data.persona??null]);
    reply.code(201);return {conversation:present(mapConversation(result.rows[0]),projectPublicConversation)};
  });
  app.get(`${prefix}/conversations/:id`,secure,async request=>{
    const id=params(request),result=await db.query('SELECT * FROM platform_conversations WHERE id=$1 AND user_id=$2',[id,userId(request)]);
    if(!result.rowCount)throw notFound();
    const messages=await db.query("SELECT m.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.filename,'mime',u.mime,'size',u.byte_size,'url','/api/platform/uploads/'||u.id)) FROM platform_uploads u WHERE u.user_id=$2 AND u.id IN (SELECT jsonb_array_elements_text(m.attachments)::uuid)), '[]'::jsonb) AS attachment_metadata FROM platform_messages m WHERE m.conversation_id=$1 ORDER BY m.ordinal",[id,userId(request)]);
    const mapped=[];
    for(const row of messages.rows){if(!config.workbenchEnabled&&row.role==='tool')continue;row.audio_transcript_metadata=await audioTranscriptions.forMessage(userId(request),row.audio_transcripts);mapped.push(mapMessage(row));}
    return {conversation:present(mapConversation(result.rows[0]),projectPublicConversation),messages:mapped.map(message=>present(message,projectPublicMessage))};
  });
  app.get(`${prefix}/conversations/:id/tasks`,secure,async request=>present(await jobs.conversationTasks(userId(request),params(request),request.query),projectPublicConversationTaskPage));
  app.get(`${prefix}/conversations/:id/goal-plans`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return present(await goalPlans.list(userId(request),params(request)),projectPublicGoalPlanList);});
  app.get(`${prefix}/conversations/:id/goal-plan-proposals`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return present(await goalPlanProposals.list(userId(request),params(request),request.query),projectPublicGoalPlanProposalList);});
  app.post(`${prefix}/conversations/:id/goal-plans`,secure,async(request,reply)=>{const id=params(request);if(!config.workbenchEnabled&&!(await db.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2',[id,userId(request)])).rowCount)throw notFound();assertHttpWorkbench(config);const plan=await goalPlans.create(userId(request),id,request.body);reply.code(201).header('Cache-Control','private, no-store');return {plan:present(plan,projectPublicGoalPlan)};});
  app.get(`${prefix}/goal-plans/:id`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return {plan:present(await goalPlans.get(userId(request),params(request)),projectPublicGoalPlan)};});
  app.put(`${prefix}/goal-plans/:id`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');const id=params(request);if(!config.workbenchEnabled)await goalPlans.get(userId(request),id);assertHttpWorkbench(config);return {plan:present(await goalPlans.update(userId(request),id,request.body),projectPublicGoalPlan)};});
  app.post(`${prefix}/goal-plans/:id/confirm`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');const id=params(request);if(!config.workbenchEnabled&&(await goalPlans.get(userId(request),id)).status==='draft')assertHttpWorkbench(config);return {plan:present(await goalPlans.confirm(userId(request),id,request.body),projectPublicGoalPlan)};});
  app.post(`${prefix}/goal-plans/:id/state`,control,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return {plan:present(await goalPlans.state(userId(request),params(request),request.body),projectPublicGoalPlan)};});
  app.post(`${prefix}/goal-plans/:id/continue`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);try{reply.header('Cache-Control','private, no-store');return present(await goalPlans.continue(userId(request),params(request),request.body,cancellation.signal,()=>assertHttpWorkbench(config)),projectPublicGoalPlanContinueResult);}finally{cancellation.dispose();}
  });
  app.delete(`${prefix}/conversations/:id`,secure,async request=>{
    const result=await db.query('DELETE FROM platform_conversations WHERE id=$1 AND user_id=$2 RETURNING id',[params(request),userId(request)]);if(!result.rowCount)throw notFound();return {ok:true};
  });
  app.get(`${prefix}/conversations/:id/voice-records`,secure,async request=>({records:(await listVoiceRecords(db,userId(request),params(request))).map(record=>present(record,projectPublicVoiceRecord))}));
  app.post(`${prefix}/conversations/:id/voice-records`,secure,async(request,reply)=>{
    const result=await saveVoiceRecord(db,userId(request),params(request),request.body);reply.code(result.created?201:200);return {...result,record:present(result.record,projectPublicVoiceRecord)};
  });
  app.post(`${prefix}/conversations/:id/messages`,secured('chat'),async(request,reply)=>{
    const id=params(request),uid=userId(request),data=serverMessageInput(config,runtime,request.body),sink=new SseTurnSink(request,reply);
    await conversationTurns.submit({userId:uid,conversationId:id,data,...(!config.workbenchEnabled?{suppressSavedPersona:true}:{})},config.workbenchEnabled?sink:new ProjectingTurnSink(sink),{
      assertAccount:signal=>assertRequestAccount(request,uid,signal),
      requestAdmission:modelConsent.forSession(fixedRequestSession(request,uid)),
    });
  });

  app.get(`${prefix}/jobs`,secure,async request=>({jobs:(await jobs.list(userId(request))).map(job=>present(job,projectPublicJob))}));
  app.post(`${prefix}/jobs`,secure,async(request,reply)=>{assertHttpWorkbench(config);const result=await jobs.create(userId(request),parseJob(request.body),undefined,undefined,undefined,()=>assertHttpWorkbench(config));reply.code(201);return {...result,job:present(result.job,projectPublicJob),...(result.approval?{approval:present(result.approval,projectPublicApproval)}:{})};});
  app.get(`${prefix}/jobs/:id`,secure,async request=>({job:present(await jobs.get(userId(request),params(request)),projectPublicJob)}));
  app.post(`${prefix}/jobs/:id/cancel`,control,async request=>({job:present(await jobs.cancel(userId(request),params(request)),projectPublicJob)}));
  app.post(`${prefix}/jobs/:id/retry`,secure,async request=>({job:present(await jobs.retry(userId(request),params(request),()=>assertHttpWorkbench(config)),projectPublicJob)}));
  app.get(`${prefix}/jobs/:id/outcome-review`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);
    try{reply.header('Cache-Control','private, no-store');return present(await jobOutcomeReviews.get(userId(request),params(request),request.query,cancellation.signal),projectPublicJobOutcomeReviewPage);}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/jobs/:id/outcome-reviews`,control,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);
    try{reply.header('Cache-Control','private, no-store');return present(await jobOutcomeReviews.save(userId(request),params(request),request.body,cancellation.signal),projectPublicJobOutcomeReviewSaved);}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/approvals`,secure,async request=>{const result=await db.query('SELECT * FROM platform_approvals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[userId(request)]);return {approvals:result.rows.map(row=>present(mapApproval(row),projectPublicApproval))};});
  app.post(`${prefix}/approvals/:id/decision`,secure,async request=>{
    const data=object(request.body);if(!['approved','rejected'].includes(String(data.decision)))throw invalid('Decision must be approved or rejected.');
    return {approval:present(await jobs.decide(userId(request),params(request),data.decision as 'approved'|'rejected',()=>assertHttpWorkbench(config)),projectPublicApproval)};
  });
  app.get(`${prefix}/mcp/connections`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return {connections:await jobs.mcp.list(userId(request))};});
  app.post(`${prefix}/mcp/connections`,control,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);
    try{const connection=await jobs.mcp.connect(userId(request),request.body,cancellation.signal);reply.code(201).header('Cache-Control','private, no-store');return {connection};}
    finally{cancellation.dispose();}
  });
  app.delete(`${prefix}/mcp/connections/:id`,control,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return {connection:await jobs.mcp.revoke(userId(request),params(request),request.body)};});
  app.get(`${prefix}/mcp/connections/:id/tools`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return jobs.mcp.tools(userId(request),params(request));});
  app.post(`${prefix}/mcp/tasks`,secure,async(request,reply)=>{assertHttpWorkbench(config);const created=await jobs.create(userId(request),mcpJobInput(request.body));reply.code(201).header('Cache-Control','private, no-store');return {...created,job:present(created.job,projectPublicJob),...(created.approval?{approval:present(created.approval,projectPublicApproval)}:{})};});
  app.get(`${prefix}/mcp/tasks/:id/result`,secure,async(request,reply)=>{
    const parsed=parseArtifactTextQuery(params(request),request.query),{artifactId,...page}=parsed,cancellation=requestSignal(request,reply);
    try{const result=await jobs.mcp.result(userId(request),{jobId:artifactId,...page},cancellation.signal);reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');return {result};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/memories`,secure,async request=>{const result=await db.query('SELECT * FROM platform_memories WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[userId(request)]);return {memories:result.rows.map(row=>({id:row.id,content:row.content,createdAt:new Date(row.created_at).toISOString()}))};});
  app.post(`${prefix}/memories`,secure,async(request,reply)=>{const data=object(request.body),id=randomUUID();const result=await db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3) RETURNING *',[id,userId(request),string(data.content,'content',4000)]);reply.code(201);return {memory:{id,content:result.rows[0].content,createdAt:new Date(result.rows[0].created_at).toISOString()}};});
  app.delete(`${prefix}/memories/:id`,secure,async request=>{const result=await db.query('DELETE FROM platform_memories WHERE id=$1 AND user_id=$2 RETURNING id',[params(request),userId(request)]);if(!result.rowCount)throw notFound();return {ok:true};});
  app.get(`${prefix}/knowledge-sources`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return {sources:await knowledge.list(userId(request))};});
  app.get(`${prefix}/knowledge-sources/:id`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return {source:await knowledge.get(userId(request),params(request))};});
  app.post(`${prefix}/knowledge-sources`,secure,async(request,reply)=>{const source=await knowledge.create(userId(request),request.body);reply.code(201).header('Cache-Control','private, no-store');return {source};});
  app.put(`${prefix}/knowledge-sources/:id`,secure,async(request,reply)=>{reply.header('Cache-Control','private, no-store');return {source:await knowledge.update(userId(request),params(request),request.body)};});
  app.delete(`${prefix}/knowledge-sources/:id`,secure,async request=>{await knowledge.remove(userId(request),params(request),request.body);return {ok:true};});
  app.post(`${prefix}/knowledge-search`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);
    try{reply.header('Cache-Control','private, no-store');return await knowledge.search(userId(request),request.body,cancellation.signal);}
    finally{cancellation.dispose();}
  });

  async function saveUpload(uid:string,name:string,mime:string,bytes:Uint8Array){
    const id=randomUUID(),key=randomUUID(),filename=path.basename(name.replaceAll('\\','/')).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200)||'file';
    await storage.put(key,bytes,mime);
    try{await db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)',[id,uid,filename,mime,bytes.byteLength,key]);}
    catch(error){const persisted=await db.query('SELECT id FROM platform_uploads WHERE id=$1 AND user_id=$2',[id,uid]).catch(()=>undefined);if(persisted&&!persisted.rowCount)await storage.delete(key).catch(()=>{});throw error;}
    return {id,name:filename,mime,size:bytes.byteLength,url:`${prefix}/uploads/${id}`};
  }
  app.post(`${prefix}/uploads`,secure,async(request,reply)=>{
    const file=await request.file();if(!file)throw invalid('Choose a file to upload.');const bytes=await file.toBuffer();if(file.file.truncated)throw new ApiError(413,'FILE_TOO_LARGE','Files must be at most 20 MB.');
    validateUpload(file.filename,file.mimetype,bytes);const attachment=await saveUpload(userId(request),file.filename,file.mimetype,bytes);reply.code(201);return {attachment};
  });
  async function serveFile(request:FastifyRequest,reply:FastifyReply,artifact=false){
    return servePrivateFile(db,storage,request,reply,userId(request),params(request),artifact);
  }
  app.route({method:['GET','HEAD'],url:`${prefix}/uploads/:id`,...secureFile,handler:async(request,reply)=>serveFile(request,reply)});
  app.route({method:['GET','HEAD'],url:`${prefix}/artifacts/:id`,...secureFile,handler:async(request,reply)=>serveFile(request,reply,true)});
  app.get(`${prefix}/artifacts/:id/reference-attachment`,secure,async request=>jobs.referenceAttachment(userId(request),params(request)));
  app.post(`${prefix}/uploads/:id/transcriptions`,secured('transcription'),async(request,reply)=>{
    const cancellation=requestSignal(request,reply),uid=userId(request),session=fixedRequestSession(request,uid);
    try{const result=await audioTranscriptions.create(uid,params(request),request.body,cancellation.signal,(client,signal)=>authorizeFixedSession(client,session,signal),modelConsent.forSession(session,cancellation.signal));reply.code(result.created?201:200).header('Cache-Control','private, no-store');return {...result,receipt:present(result.receipt,projectPublicAudioTranscriptionReceipt)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/uploads/:id/transcriptions/:clientRequestId`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply),route=request.params as {id:string;clientRequestId:string};
    try{const receipt=await audioTranscriptions.get(userId(request),identifier(route.id),identifier(route.clientRequestId),cancellation.signal);reply.header('Cache-Control','private, no-store');return {receipt:present(receipt,projectPublicAudioTranscriptionReceipt)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/audio-transcriptions/:id`,secure,async(request,reply)=>{
    const cancellation=requestSignal(request,reply);
    try{const receipt=await audioTranscriptions.getById(userId(request),params(request),cancellation.signal);reply.header('Cache-Control','private, no-store');return {receipt:present(receipt,projectPublicAudioTranscriptionReceipt)};}
    finally{cancellation.dispose();}
  });
  app.get(`${prefix}/artifacts/:id/text`,secure,async(request,reply)=>{
    const input=parseArtifactTextQuery(params(request),request.query),cancellation=requestSignal(request,reply);
    try{const result=await jobs.artifactText(userId(request),input,cancellation.signal);reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');return result;}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/voice/session`,secured('realtime'),async(request,reply)=>{
    const cancellation=requestSignal(request,reply),uid=userId(request),sessionId=randomUUID(),session=fixedRequestSession(request,uid);
    let acquired=false;
    try{
      const data=voiceBody(request.body===undefined?{}:request.body,['conversationId']),route=resolveModelRoute(config,runtime,'realtime');
      const {provider,model,voice}=route,turnTaking=runtime.capabilities().find(item=>item.id===provider)?.voiceOptions?.realtime?.turnTaking===true?'patient':undefined,usageId=randomUUID();
      const conversationId=data.conversationId===undefined?undefined:identifier(data.conversationId).toLowerCase();
      let serverContext:VoiceContextSnapshot|undefined;
      await assertRequestAccount(request,uid,cancellation.signal);
      await db.transaction(async client=>{
        await authorizeFixedSession(client,session,cancellation.signal);
        if(conversationId)serverContext=await readVoiceContext(client,uid,conversationId);
        await acquireRuntimeLease(client,uid,'voice',sessionId,600);
        const recent=await client.query("SELECT count(*)::integer AS count FROM platform_usage WHERE user_id=$1 AND capability='realtime' AND created_at > now()-interval '1 hour'",[uid]);
        if(recent.rows[0].count>=4)throw new ApiError(429,'VOICE_SESSION_LIMIT','The hourly voice-session limit has been reached.');
        await client.query("INSERT INTO platform_usage(id,user_id,provider,model,capability) VALUES($1,$2,$3,$4,'realtime')",[usageId,uid,provider,model??null]);
        cancellation.signal.throwIfAborted();
      });
      acquired=true;await assertRequestAccount(request,uid,cancellation.signal);
      const result=await runtime.createVoiceSession({provider,model,voice,...(turnTaking===undefined?{}:{turnTaking})},{signal:cancellation.signal,requestAdmission:modelConsent.forSession(session,cancellation.signal)});
      await assertRequestAccount(request,uid,cancellation.signal);
      await rememberVoiceSession(db,uid,sessionId,provider,result.model,{conversationId,authorize:client=>authorizeFixedSession(client,session,cancellation.signal)});
      await db.query('UPDATE platform_usage SET model=$3 WHERE id=$1 AND user_id=$2',[usageId,uid,string(result.model,'voice model',150)]);
      await assertRequestAccount(request,uid,cancellation.signal);
      if(conversationId)await db.transaction(async client=>{await authorizeFixedSession(client,session,cancellation.signal);await assertVoiceConversation(client,uid,conversationId);cancellation.signal.throwIfAborted();});
      const response:VoiceSessionResponse={...result,sessionId,...(serverContext?{serverContext}:{})};
      reply.header('Cache-Control','private, no-store');return present(response,projectPublicVoiceSessionResponse);
    }catch(error){if(acquired)await releaseVoiceSession(db,uid,sessionId);throw error;}
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/voice/session/release`,control,async request=>{const data=object(request.body);await releaseVoiceSession(db,userId(request),identifier(data.sessionId));return {ok:true};});
  app.post(`${prefix}/voice/transcribe`,secured('transcription'),async(request,reply)=>{
    const cancellation=requestSignal(request,reply),session=fixedRequestSession(request,userId(request));
    try{
      let audio:ProviderAttachment|undefined;
      for await(const part of request.parts({limits:{fileSize:20*1024*1024,files:1,fields:1,parts:2,fieldSize:80,fieldNameSize:32}})){
        cancellation.signal.throwIfAborted();
        if(part.type==='file'){
          const bytes=await part.toBuffer();
          if(part.file.truncated)throw new ApiError(413,'FILE_TOO_LARGE','Files must be at most 20 MB.');
          if(part.fieldname!=='file'||audio)throw invalid('Exactly one audio file named file is required.');
          validateUpload(part.filename,part.mimetype,bytes);
          if(!part.mimetype.startsWith('audio/')&&part.mimetype!=='video/webm')throw invalid('An audio file is required.');
          audio={name:part.filename,mime:part.mimetype,bytes};
        }else{
          throw invalid('Only one audio file may be supplied. Voice routing is managed by the server.');
        }
      }
      if(!audio)throw invalid('An audio file is required.');
      const {provider}=resolveModelRoute(config,runtime,'transcription');
      cancellation.signal.throwIfAborted();
      return await withVoiceLease(db,userId(request),()=>{cancellation.signal.throwIfAborted();return runtime.transcribe(audio!,{provider,signal:cancellation.signal,requestAdmission:modelConsent.forSession(session,cancellation.signal)});});
    }
    finally{cancellation.dispose();}
  });
  app.post(`${prefix}/voice/speech`,secured('speech'),async(request,reply)=>{
    const cancellation=requestSignal(request,reply),session=fixedRequestSession(request,userId(request));
    try{
      const data=voiceBody(request.body,config.workbenchEnabled?['text']:['text','message_id']);
      if(!config.workbenchEnabled)throw new ApiError(403,'SPEECH_NOT_AVAILABLE','Speech playback is not available on this channel.');
      const text=string(data.text,'text',4000),{provider,model,voice}=resolveModelRoute(config,runtime,'speech'),input={provider,text,voice,model};
      cancellation.signal.throwIfAborted();
      const audio=await withVoiceLease(db,userId(request),()=>{cancellation.signal.throwIfAborted();return runtime.speech(input,{signal:cancellation.signal,requestAdmission:modelConsent.forSession(session,cancellation.signal)});});
      cancellation.signal.throwIfAborted();const attachment=await saveUpload(userId(request),audio.name,audio.mime,audio.bytes);reply.code(201);return {attachment};
    }finally{cancellation.dispose();}
  });

  const streamRecovery=setInterval(()=>void recoverStaleStreams(db).catch(()=>{}),30_000);streamRecovery.unref();
  app.addHook('onClose',async()=>{
    clearInterval(streamRecovery);
    const results=await Promise.allSettled([readiness.close(),queue?.close(),companionQueue?.close(),companionNameQueue?.close()]);
    if(!options.db)await db.close();
    if(results.some(result=>result.status==='rejected'))throw new Error('Platform shutdown could not be confirmed.');
  });
  try{
    if(config.webStaticDir)await configureStaticWeb(app,config.webStaticDir);
    await app.ready();
    if(queue)queue.start();
    if(companionQueue)companionQueue.start();
    if(companionNameQueue)companionNameQueue.start();
  }catch(error){await app.close();throw error;}
  return {app,db,jobs,queue,companion,companionQueue,studentOnboarding,safetyResources,naming,companionNameQueue,runtime,goalPlans,goalPlanProposals,jobOutcomeReviews,audioTranscriptions,conversationTurns};
}
