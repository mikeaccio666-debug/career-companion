import type { CommercialUsageView } from '@edaix/contracts';
/** Internal presentation types. Production wire adapters must import @edaix/contracts. */
export type Scene = 'welcome' | 'home' | 'chat' | 'profile' | 'deck' | 'batchend' | 'shortlist' | 'preparing' | 'cover' | 'autofill';
export type Phase = 0 | 1 | 2;
export type SessionState = 'out' | 'connecting' | 'connected' | 'expired' | 'unavailable';
export type ProfileField = 'name' | 'nick' | 'email' | 'phone' | 'city' | 'links' | 'role' | 'locations' | 'workMode' | 'salary' | 'start' | 'notice' | 'workAuth' | 'sponsorship' | 'gender' | 'race' | 'disability' | 'veteran' | 'education' | 'projects' | 'languages' | 'summary';
export type Profile = Record<ProfileField, string> & { experience: string[]; skills: string[] };
export interface Mentor { id: string; src: string; name: string }
export interface ResumeOption { id: string; track: string; version: string; label: string; kind: 'existing' | 'generated'; current: boolean; note: string }
export interface Target { id: string; role: string; locations: string; workMode: string; salary: string; start: string; source: string; savedAt: string }
export interface ProfilePhase { id: Phase; title: string; short: string; intro: string; introNoResume?: string; hint: string; fields: ProfileField[]; demoVoice: string }
export interface FieldMeta { label: string; group: string; self?: boolean; optional?: boolean }
export interface ExtractHit { field: ProfileField | 'decline'; value: string; start: number; end: number; label?: string }
export interface TextSegment { id: string; text: string; key: boolean; field?: ProfileField | 'decline' }
export interface Extraction { segments: TextSegment[]; hits: ExtractHit[] }
export interface CandidateField {
  edited?: boolean;
  key: ProfileField; label: string; value: string; source: string; srcBg: string; srcColor: string;
  placeholder: string; isInput: boolean; isSelect: boolean; options: { v: string; t: string }[]; fromHit: boolean;
}
export interface CandidateCard {
  phase: Phase; fields: CandidateField[]; editable: boolean; readOnly: boolean; busy: boolean; targetId: string | null;
  eyebrow: string; title: string; badge: string; badgeBg: string; badgeColor: string; confirmLabel: string; note: string;
  notice: boolean; noticeText: string; noticeBg: string; noticeActions: { act: string; label: string }[];
}
export interface UploadState { state: 'idle' | 'uploading' | 'reading' | 'organizing' | 'failed' | 'done' | 'skipped'; slow?: boolean }
export type ChatMessage =
  | { id: string; role: 'ai'; text: string; stream: boolean; onDone: 'privacy' | 'review' | 'more' | null }
  | { id: string; role: 'user'; text: string; segments: TextSegment[]; hits: ExtractHit[]; fromVoice: boolean; showExtract: boolean }
  | { id: string; role: 'card'; card: CandidateCard }
  | { id: string; role: 'upload'; upload: UploadState }
  | { id: string; role: 'notice'; text: string; bg: string; actions: { act: string; label: string }[] };
export interface Job {
  description?: string;
  id: string; company: string; title: string; location: string; mode: string; type: string; salary: string | null;
  salaryUnit: string | null; summary: string; matches: string[]; gap: string; source: string; posted: string; boardUrl: string; jdDigest: string;
  coverLetterRequirement: 'REQUIRED' | 'UNKNOWN' | 'NOT_REQUIRED';
  responsibilities: string[]; requirements: string[];
}
export interface DimensionDefinition { label: string; max: number; desc: string }
export interface AtsReport {
  definitions?: Record<string, DimensionDefinition>;
  total: number; max: number; dims: Record<string, [number, string[]] | null>; problems: string[];
  suggestions: string[]; missing: string[]; rubricVersion: string; measuredAt: string;
}
export type UsageKind = 'ats' | 'jobs' | 'letters' | 'chat' | 'voice';
export interface Entitlement {
  usage?: CommercialUsageView;
  reserved?: number;
  access: 'granted' | 'locked' | 'sync' | 'unavailable'; unit?: string; period?: string | null;
  limit?: number | null; used?: number; remaining?: number | null; resetsAt?: string; serviceDown?: boolean; sourceExhausted?: boolean;
}
export type RowOutcome = 'filled' | 'kept' | 'manual';
export interface RunRow { key: string; label: string; source: string; outcome: RowOutcome; note?: string }
export interface RunProgressRow extends RunRow { state: 'pending' | 'active' | RowOutcome | 'failed' }
export interface RunState { status: 'idle' | 'running' | 'done' | 'paused'; count: number; rows: RunProgressRow[]; failed: boolean }
export interface Modal { title: string; text: string; actions: { id: string; label: string; primary?: boolean; ghost?: boolean }[] }
export interface Sheet { kind: 'targets' | 'ats' | 'jd' | 'usage' | 'resume' | 'fill' | 'letters'; id?: string; sample?: boolean }
export interface Letter { status: 'generating' | 'draft' | 'kept' | 'failed'; text: string; edited?: boolean }
export type Preparation = 'queued' | 'preparing' | 'ready' | 'failed';
export interface AssistantData {
  profile: Profile; mentors: Mentor[]; resumeVersions: ResumeOption[]; phases: ProfilePhase[];
  fieldMeta: Partial<Record<ProfileField, FieldMeta>>; jobs: Job[]; dimensionCatalog: Record<string, DimensionDefinition>;
  usageLabels: Record<UsageKind, string>; runRows: RunRow[];
  sampleReports?: Record<string, AtsReport>;
}
export interface AssistantState {
  autofill?: import('../features/autofill/controller').ConnectedAutofillState;
  materials?: import('../features/connected-materials-controller').ConnectedMaterialsState;
  commerceEnabled?: boolean;
  commerce?: import('../features/commerce/controller').CommerceState;
  jobOptions?: Job[];
  intakeEnabled?: boolean;
  privateIntake?: import('../features/intake/private-controller').PrivateIntakeState;
  roleManagementEnabled?: boolean;
  roleManager?: import('../features/targets/controller').RoleManagerState;
  profileEditingEnabled?: boolean;
  profileEditor?: import('../features/profile/editor-model').ProfileEditorState;
  /** Bounded, value-free local diagnostic; never contains an owner, URL, or response body. */
  connectionIssue?: { stage: 'CONNECTION' | 'SESSION' | 'READS' | 'PERSONAL' | 'PROFILE_V2' | 'RESUMES' | 'VERIFY'; code: import('@edaix/contracts').AssistantReadCode };
  locale?: import('../i18n').AssistantLocale;
  /** Present only in the read-only connected composition; absence means the visual preview. */
  reads?: { personal: 'loading' | 'ready' | 'unavailable' | 'locked'; profileV2?: 'loading' | 'ready' | 'unavailable' | 'locked'; resumes: 'loading' | 'ready' | 'unavailable' | 'locked'; processingCount: number; failedCount: number; hasMoreVersions: boolean };
  profileV2?: import('@edaix/contracts').CandidateProfileSnapshotV2;
  resumeOptions?: ResumeOption[];
  scene: Scene; reduced: boolean; panelOpen: boolean; launcherHidden: boolean; hiddenNote: boolean; launcherTop: number;
  session: SessionState;
  /**
   * 成功连接过至少一次。用来把「从没连过」和「连过但断了」分开——两者的
   * session 都会是 'unavailable'，但前者该给"连接"，后者才该给"刷新"。
   * 2026-09-16 加：在此之前两者共用"刷新连接"，而 refresh 假设连接存在，
   * 首次使用的人点它必然失败。
   */
  everConnected?: boolean;
  hasResume: boolean; resumeId: string; profile: Profile; profileDone: boolean;
  confirmed: Record<Phase, boolean>; privacy: 'unset' | 'skipped' | 'declined' | 'provided';
  targets: Target[]; currentTargetId: string | null; addingTarget: boolean;
  chat: { phase: Phase; messages: ChatMessage[]; input: string; stage: 'idle' | 'thinking' | 'extracting' | 'card'; privacyPrompt: boolean; reviewPrompt: boolean; morePrompt: boolean; initialized: boolean };
  voice: { state: 'idle' | 'recording' | 'processing' | 'transcript'; secs: number; notice: string; draft: string };
  deck: { items: string[]; index: number; cursor: number; batchNo: number; selected: string[]; skipped: string[]; history: { id: string; accept: boolean }[]; busy: boolean; closedJob: string };
  atsResults: Record<string, { status: 'scoring' | 'pending' | 'failed' | 'ready'; resumeId: string; reportId?: string; failureCode?: import('@edaix/contracts').AtsReportFailure; report?: AtsReport }>;
  staleIds: Record<string, boolean>;
  entitlements: Record<UsageKind, Entitlement>;
  prep: Record<string, Preparation>; preparedResume: Record<string, string>; letters: Record<string, Letter>;
  coverId: string; fillId: string; run: RunState;
  sheet: Sheet | null; modal: Modal | null; toast: string; hostHighlight: boolean;
}
