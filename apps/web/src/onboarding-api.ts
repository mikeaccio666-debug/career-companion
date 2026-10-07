import { ONBOARDING_BASIC_QUESTIONS, ONBOARDING_SCENARIO_QUESTIONS,
  type OnboardingAnswerSummary, type OnboardingCommand, type OnboardingDraft, type OnboardingEntryState, type OnboardingFollowupCommand,
  type OnboardingFollowupResult, type OnboardingFollowupState, type OnboardingPublicSafetyResponse,
  type OnboardingResourceAction, type OnboardingSafetyPublication, type OnboardingSaveResult } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';

const questions = [...ONBOARDING_BASIC_QUESTIONS, ...ONBOARDING_SCENARIO_QUESTIONS, 'extra'] as const;
function invalid(): never { throw new Error('初见进度暂时无法确认，请重新读取。'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some(d => !('value' in d) || !d.enumerable)) invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function text(value: unknown, maximum = 10000): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]/u.test(value)) invalid(); return value;
}
function uuid(value: unknown): string { const id = text(value, 36); if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(id)?.[0] !== id) invalid(); return id.toLowerCase(); }
function integer(value: unknown, minimum = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 2147483647) invalid(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function member<T extends string>(value: unknown, options: readonly T[]): T { if (typeof value !== 'string' || !options.includes(value as T)) invalid(); return value as T; }
function timestamp(value: unknown): string { const at = text(value, 40); if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) invalid(); return at; }
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value), length = descriptors.length.value;
  if (!Number.isSafeInteger(length) || length > 10000 || Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || /^(0|[1-9][0-9]*)$/.exec(key)?.[0] !== key || Number(key) >= length))
    || Object.values(descriptors).some(d => !('value' in d))) invalid();
  return Array.from({ length }, (_, index) => { if (!descriptors[index]?.enumerable) invalid(); return descriptors[index].value; });
}
function answerValue(questionId: string, value: unknown): unknown {
  if (questionId === 'study') { const data = record(value, ['degreeField', 'programChoice']); return { degreeField: member(data.degreeField, ['cs', 'ds_statistics', 'ece_ee', 'other_stem']), programChoice: data.programChoice === null ? null : member(data.programChoice, ['12_month', '16_month', '24_month', 'other']) }; }
  if (questionId === 'graduation') { const data = record(value, ['month', 'graduated']), month = text(data.month, 7); if (/^[0-9]{4}-(0[1-9]|1[0-2])$/.exec(month)?.[0] !== month || month.startsWith('0000')) invalid(); return { month, graduated: boolean(data.graduated) }; }
  if (questionId === 'roles') { const data = record(value, ['kind'], ['roles']); if (data.kind === 'undecided') { if (Object.hasOwn(data, 'roles')) invalid(); return { kind: 'undecided' }; } member(data.kind, ['selected']); const roles = array(data.roles).map(role => member(role, ['swe', 'mle', 'ds', 'da', 'de', 'hw', 'other'])); if (!roles.length || new Set(roles).size !== roles.length) invalid(); return { kind: 'selected', roles }; }
  if (questionId === 'search_stage') return member(value, ['not_started', 'applying', 'interviewing', 'offer', 'graduated_looking']);
  if (questionId === 'emotion_language') return member(value, ['zh', 'en', 'either']);
  if (questionId === 'identity_stage') return member(value, ['f1_student', 'opt', 'stem_opt', 'other', 'prefer_not_say']);
  if (questionId === 'extra') return { textId: uuid(record(value, ['textId']).textId) };
  return member(value, ['Q1', 'Q3', 'Q4'].includes(questionId) ? ['A', 'B', 'C', 'D'] : ['A', 'B', 'C']);
}
/** Browser boundary codec only. Authoritative question transitions and history validation stay on the server. */
export function parsePublicOnboardingDraft(value: unknown, accountId: string): OnboardingDraft {
  const data = record(value, ['schemaVersion', 'questionnaireRevision', 'rulesRevision', 'id', 'userId', 'revision', 'step', 'currentQuestion', 'state', 'fastTrack', 'answersPartial', 'updatedAt'], ['pendingText', 'safety']);
  if (data.schemaVersion !== 1 || data.questionnaireRevision !== 1 || data.rulesRevision !== 1 || uuid(data.userId) !== accountId) invalid();
  const revision = integer(data.revision), answers = record(data.answersPartial, [], questions), parsed: Record<string, unknown> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    const base = record(value, ['kind', 'appliedRevision'], ['value', 'source', 'textId', 'reason']), appliedRevision = integer(base.appliedRevision, 1); if (appliedRevision > revision) invalid();
    if (base.kind === 'answered') { const answer = record(value, ['kind', 'appliedRevision', 'value', 'source'], ['textId']); member(answer.source, ['user_entered']); parsed[questionId] = { kind: 'answered', appliedRevision, value: answerValue(questionId, answer.value), source: 'user_entered', ...(Object.hasOwn(answer, 'textId') ? { textId: uuid(answer.textId) } : {}) }; }
    else { member(base.kind, ['skipped']); const reason = member(base.reason, ['user', 'fast_track', 'remaining', 'unmatched_text']); const skipped = record(value, ['kind', 'appliedRevision', 'reason'], reason === 'unmatched_text' ? ['textId'] : []); if (reason === 'unmatched_text' && !Object.hasOwn(skipped, 'textId')) invalid(); parsed[questionId] = { kind: 'skipped', appliedRevision, reason, ...(reason === 'unmatched_text' ? { textId: uuid(skipped.textId) } : {}) }; }
  }
  const draft: OnboardingDraft = { schemaVersion: 1, questionnaireRevision: 1, rulesRevision: 1, id: uuid(data.id), userId: uuid(data.userId), revision,
    step: member(data.step, ['O1', 'O2', 'O3', 'O4', 'O5']), currentQuestion: data.currentQuestion === null ? null : member(data.currentQuestion, questions),
    state: member(data.state, ['collecting', 'safety_pending', 'safety_paused', 'intake_ready']), fastTrack: boolean(data.fastTrack), answersPartial: parsed as OnboardingDraft['answersPartial'], updatedAt: timestamp(data.updatedAt) };
  if (Object.hasOwn(data, 'pendingText')) { const pending = record(data.pendingText, ['id', 'questionId', 'submittedAtRevision']); draft.pendingText = { id: uuid(pending.id), questionId: member(pending.questionId, questions), submittedAtRevision: integer(pending.submittedAtRevision, 1) }; }
  if (Object.hasOwn(data, 'safety')) { const safety = record(data.safety, ['textId', 'questionId', 'submittedAtRevision', 'level', 'detectorRevision', 'mode']); draft.safety = { textId: uuid(safety.textId), questionId: member(safety.questionId, questions), submittedAtRevision: integer(safety.submittedAtRevision, 1), level: member(safety.level, ['L0', 'L1', 'L2']), detectorRevision: integer(safety.detectorRevision, 1), mode: member(safety.mode, ['full', 'keyword_only']) }; if (draft.safety.level === 'L0' && draft.safety.mode !== 'full') invalid(); }
  if ((draft.state === 'safety_pending') !== !!draft.pendingText || draft.pendingText && (draft.pendingText.submittedAtRevision !== revision || draft.pendingText.questionId !== draft.currentQuestion || draft.safety)
    || (draft.state === 'intake_ready') !== (draft.step === 'O5') || draft.safety && draft.safety.submittedAtRevision >= revision
    || draft.state === 'safety_paused' && (!draft.safety || draft.safety.level === 'L0' || draft.safety.questionId !== draft.currentQuestion || draft.safety.submittedAtRevision + 1 !== revision)
    || draft.state !== 'safety_paused' && draft.safety && draft.safety.level !== 'L0'
    || draft.step === 'O1' && (revision !== 0 || draft.currentQuestion !== null || draft.state !== 'collecting' || draft.fastTrack || Object.keys(parsed).length || draft.pendingText || draft.safety)) invalid();
  return draft;
}
function resourceAction(value: unknown): OnboardingResourceAction {
  const base = record(value, ['kind', 'label'], ['number', 'body', 'url']), label = text(base.label, 300);
  if (base.kind === 'web') { const data = record(value, ['kind', 'label', 'url']), url = text(data.url, 2048); const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) invalid(); return { kind: 'web', label, url }; }
  const kind = member(base.kind, ['call', 'sms']), data = record(value, ['kind', 'label', 'number', ...(kind === 'sms' ? ['body'] : [])]), number = text(data.number, 40);
  if (/^\+?[0-9]{3,15}$/.exec(number)?.[0] !== number) invalid();
  return kind === 'call' ? { kind, number, label } : { kind, number, label, body: data.body === null ? null : text(data.body, 1000) };
}
export function onboardingResourceHref(action: OnboardingResourceAction): string {
  const checked = resourceAction(action);
  return checked.kind === 'web' ? checked.url : checked.kind === 'call' ? `tel:${checked.number}` : `sms:${checked.number}${checked.body === null ? '' : `?body=${encodeURIComponent(checked.body)}`}`;
}
function response(value: unknown): OnboardingPublicSafetyResponse {
  const data = record(value, ['text', 'resourceCard'], ['question']), card = record(data.resourceCard, ['title', 'schoolUnknown', 'footer', 'outsideUs', 'contacts']), outside = record(card.outsideUs, ['label', 'text']);
  return { text: text(data.text), ...(Object.hasOwn(data, 'question') ? { question: text(data.question, 1000) } : {}), resourceCard: {
    title: text(card.title, 500), schoolUnknown: text(card.schoolUnknown, 2000), footer: text(card.footer, 2000), outsideUs: { label: text(outside.label, 500), text: text(outside.text, 2000) },
    contacts: array(card.contacts).map(value => { const contact = record(value, ['id', 'verifiedAt', 'name', 'description', 'actions']); return { id: text(contact.id, 100), verifiedAt: timestamp(contact.verifiedAt), name: text(contact.name, 500), description: text(contact.description, 2000), actions: array(contact.actions).map(resourceAction) }; }),
  } };
}
function publication(value: unknown): OnboardingSafetyPublication {
  const data = record(value, ['publicationId', 'responseId', 'submissionId', 'level', 'publishedAt', 'retentionUntil', 'response', 'presented', 'acknowledged', 'handled', 'clarifiedAt']);
  const parsed = { publicationId: uuid(data.publicationId), responseId: uuid(data.responseId), submissionId: uuid(data.submissionId), level: member(data.level, ['L1', 'L2']), publishedAt: timestamp(data.publishedAt), retentionUntil: timestamp(data.retentionUntil), response: response(data.response), presented: boolean(data.presented), acknowledged: boolean(data.acknowledged), handled: boolean(data.handled), clarifiedAt: data.clarifiedAt === null ? null : timestamp(data.clarifiedAt) };
  if (parsed.acknowledged && !parsed.presented || parsed.handled && !parsed.acknowledged || Date.parse(parsed.retentionUntil) <= Date.parse(parsed.publishedAt)) invalid(); return parsed;
}
export function parseOnboardingFollowupState(value: unknown, accountId: string, entry = false): OnboardingFollowupState {
  const data = record(value, ['draft', 'publications', 'pendingResponses', 'safety'], entry ? ['freeTextAvailable', 'question', 'answerSummaries'] : []), safety = record(data.safety, ['status', 'pendingCount', 'blockedLevel']);
  const publications = array(data.publications).map(publication); if (new Set(publications.map(p => p.publicationId)).size !== publications.length) invalid();
  return { draft: data.draft === null ? null : parsePublicOnboardingDraft(data.draft, accountId), publications,
    pendingResponses: array(data.pendingResponses).map(value => { const data = record(value, ['responseId', 'submissionId', 'status']); return { responseId: uuid(data.responseId), submissionId: uuid(data.submissionId), status: member(data.status, ['pending', 'expired']) }; }),
    safety: { status: member(safety.status, ['clear', 'pending', 'blocked']), pendingCount: integer(safety.pendingCount), blockedLevel: safety.blockedLevel === null ? null : member(safety.blockedLevel, ['L1', 'L2'] as const) } };
}
function entry(value: unknown, accountId: string): OnboardingEntryState {
  const parsed = parseOnboardingFollowupState(value, accountId, true), data = record(value, ['draft', 'publications', 'pendingResponses', 'safety', 'freeTextAvailable', 'question', 'answerSummaries']);
  let question: OnboardingEntryState['question'] = null;
  if (data.question !== null) { const input = record(data.question, ['questionId', 'prompt', 'choices']); question = { questionId: member(input.questionId, questions), prompt: text(input.prompt, 5000), choices: array(input.choices).map(value => { const option = record(value, ['value', 'label']); return { value: text(option.value, 100), label: text(option.label, 500) }; }) }; if (new Set(question.choices.map(choice => choice.value)).size !== question.choices.length || question.questionId !== parsed.draft?.currentQuestion) invalid(); }
  const answeredQuestions = questions.filter(questionId => !!parsed.draft?.answersPartial[questionId]);
  const answerSummaries = array(data.answerSummaries).map((value, index): OnboardingAnswerSummary => {
    const summary = record(value, ['questionId', 'prompt', 'label', 'appliedRevision', 'kind'], ['reason']), questionId = member(summary.questionId, questions), appliedRevision = integer(summary.appliedRevision, 1);
    const answer = parsed.draft?.answersPartial[questionId];
    if (!answer || questionId !== answeredQuestions[index] || appliedRevision !== answer.appliedRevision || summary.kind !== answer.kind) invalid();
    const common = { questionId, prompt: text(summary.prompt, 5000), label: text(summary.label, 1000), appliedRevision };
    if (summary.kind === 'answered') { if (Object.hasOwn(summary, 'reason')) invalid(); return { ...common, kind: 'answered' }; }
    const reason = member(summary.reason, ['user', 'fast_track', 'remaining', 'unmatched_text'] as const);
    if (answer.kind !== 'skipped' || reason !== answer.reason) invalid();
    if (questionId === 'extra' && common.label !== '补充已跳过') invalid();
    return { ...common, kind: 'skipped', reason };
  });
  if (answerSummaries.length !== answeredQuestions.length || answerSummaries.some(summary => summary.questionId === 'extra' && summary.kind === 'answered' && summary.label !== '补充已提交')) invalid();
  return { ...parsed, freeTextAvailable: boolean(data.freeTextAvailable), question, answerSummaries };
}
function operation(value: unknown): OnboardingSaveResult['operation'] { const data = record(value, ['id', 'appliedRevision', 'replayed']); return { id: uuid(data.id), appliedRevision: integer(data.appliedRevision), replayed: boolean(data.replayed) }; }
export async function readOnboardingEntry(client: BoundPlatformClient, signal?: AbortSignal): Promise<OnboardingEntryState> {
  const data = record(await client.request('/onboarding', { signal }), ['entry']); return entry(data.entry, client.account.accountId);
}
export async function saveOnboardingDraft(client: BoundPlatformClient, command: OnboardingCommand, signal?: AbortSignal): Promise<OnboardingSaveResult> {
  const data = record(await client.request('/onboarding', { method: 'PATCH', body: JSON.stringify(command), signal }), ['result']), result = record(data.result, ['draft', 'operation']);
  const parsed = { draft: parsePublicOnboardingDraft(result.draft, client.account.accountId), operation: operation(result.operation) };
  if (parsed.operation.id !== command.operationId || parsed.operation.appliedRevision !== command.expectedRevision + 1 || parsed.draft.revision < parsed.operation.appliedRevision) invalid(); return parsed;
}
export async function retryOnboardingSafety(client: BoundPlatformClient, signal?: AbortSignal): Promise<OnboardingEntryState> {
  const data = record(await client.request('/onboarding/safety/retry', { method: 'POST', body: '{}', signal }), ['entry']); return entry(data.entry, client.account.accountId);
}
export async function readOnboardingFollowup(client: BoundPlatformClient, signal?: AbortSignal): Promise<OnboardingFollowupState> {
  const data = record(await client.request('/onboarding/safety', { signal }), ['followup']); return parseOnboardingFollowupState(data.followup, client.account.accountId);
}
export async function saveOnboardingFollowup(client: BoundPlatformClient, command: OnboardingFollowupCommand, signal?: AbortSignal): Promise<OnboardingFollowupResult> {
  const data = record(await client.request('/onboarding/safety', { method: 'POST', body: JSON.stringify(command), signal }), ['result']), result = record(data.result, ['draft', 'operation', 'publicationId', 'resumeStatus'], ['presentationReceipt']);
  const parsed: OnboardingFollowupResult = { draft: parsePublicOnboardingDraft(result.draft, client.account.accountId), operation: operation(result.operation), publicationId: uuid(result.publicationId), resumeStatus: member(result.resumeStatus, ['not_requested', 'remaining_safety', 'waiting_for_safety', 'resumed']), ...(Object.hasOwn(result, 'presentationReceipt') ? { presentationReceipt: text(result.presentationReceipt, 500) } : {}) };
  if (parsed.operation.id !== command.operationId || parsed.publicationId !== command.publicationId || parsed.draft.revision < parsed.operation.appliedRevision
    || parsed.presentationReceipt !== undefined && command.action.kind !== 'present' || command.action.kind === 'present' && !parsed.presentationReceipt) invalid(); return parsed;
}
