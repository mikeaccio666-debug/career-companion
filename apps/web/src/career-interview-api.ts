import {
  careerRecordId, careerRecordObject, parseCareerInterview, parseCareerInterviewCommand,
  parseCareerInterviewOperation, type CareerInterview, type CareerInterviewAction,
  type CareerInterviewStatus,
} from '@companion/platform-contracts';

/** Portable, account-bound HTTP port. No UI, browser execution or provider calls. */
export interface InterviewRecordClient {
  readonly account: { readonly accountId: string };
  isCurrent(): boolean;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}
const root = '/career/interviews';
function current(client: InterviewRecordClient) { if (!client.isCurrent()) return fail(); }
function fail(): never { throw Error('这次面试记录暂时无法确认，请重新读取。'); }
function owned(client: InterviewRecordClient, value: unknown) {
  const record = parseCareerInterview(value);
  if (!client.isCurrent() || record.ownerId !== client.account.accountId) return fail();
  return record;
}
export async function readInterviewRecords(
  client: InterviewRecordClient, after: string | null = null,
  status: CareerInterviewStatus | null = null, signal?: AbortSignal,
) {
  current(client);
  if (status !== null && !['scheduled', 'rescheduled', 'done', 'cancelled'].includes(status)) return fail();
  const query = new URLSearchParams();
  if (after !== null) query.set('after', careerRecordId(after));
  if (status !== null) query.set('status', status);
  const v = careerRecordObject(await client.request(root + (query.size ? '?' + query : ''), { signal }), ['interviews', 'nextAfter']);
  if (!Array.isArray(v.interviews) || Object.getPrototypeOf(v.interviews) !== Array.prototype || v.interviews.length > 50) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(v.interviews), interviews: Readonly<CareerInterview>[] = [];
  if (Reflect.ownKeys(descriptors).length !== v.interviews.length + 1) return fail();
  for (let i = 0; i < v.interviews.length; i++) {
    if (!descriptors[i] || !('value' in descriptors[i]) || !descriptors[i].enumerable) return fail();
    interviews.push(owned(client, descriptors[i].value));
  }
  if (new Set(interviews.map(r => r.id)).size !== interviews.length ||
      interviews.some(r => r.id === after || status !== null && r.status !== status)) return fail();
  const nextAfter = v.nextAfter === null ? null : careerRecordId(v.nextAfter);
  if (nextAfter !== null && (interviews.length !== 50 || nextAfter !== interviews.at(-1)!.id)) return fail();
  if (!client.isCurrent()) return fail();
  return Object.freeze({ interviews: Object.freeze(interviews), nextAfter });
}
export async function readInterviewRecord(client: InterviewRecordClient, id: string, signal?: AbortSignal) {
  current(client);
  const key = careerRecordId(id);
  const v = careerRecordObject(await client.request(root + '/' + key, { signal }), ['interview']);
  const record = owned(client, v.interview);
  if (record.id !== key) return fail();
  return record;
}
export interface InterviewIntent {
  readonly action: CareerInterviewAction;
  readonly id: string | null;
  readonly body: unknown;
}
export function freezeInterviewIntent(value: InterviewIntent): Readonly<InterviewIntent> {
  const command = parseCareerInterviewCommand(value.action, value.body);
  const id = value.action === 'create' ? null : careerRecordId(value.id);
  if (value.action === 'create' && value.id !== null) return fail();
  // action is derived by the parser; the strict HTTP command does not contain it.
  const { action: _derivedAction, ...wire } = command;
  return Object.freeze({ action: value.action, id, body: Object.freeze(wire) });
}
function expectation(value: InterviewIntent) {
  const fixed = freezeInterviewIntent(value);
  return { ...fixed, command: parseCareerInterviewCommand(fixed.action, fixed.body) };
}
function result(client: InterviewRecordClient, raw: unknown, expected: ReturnType<typeof expectation>, observed: boolean) {
  const v = careerRecordObject(raw, ['interview', 'operation']);
  const operation = parseCareerInterviewOperation(v.operation), command = expected.command;
  if (operation.id !== command.operationId || operation.action !== expected.action ||
      operation.appliedRevision !== command.expectedRevision + 1 ||
      observed && !operation.replayed || expected.id !== null && operation.interviewId !== expected.id) return fail();
  const interview = v.interview === null ? null : owned(client, v.interview);
  if (!client.isCurrent() || interview && (interview.id !== operation.interviewId ||
      interview.revision < operation.appliedRevision ||
      interview.revision === operation.appliedRevision && interview.lastOperationId !== operation.id)) return fail();
  if (expected.action === 'delete' && interview !== null ||
      !operation.replayed && expected.action !== 'delete' && (!interview || interview.revision !== operation.appliedRevision)) return fail();
  if (interview?.revision === operation.appliedRevision) {
    switch (command.action) {
      case 'create':
        if (interview.application.id !== command.applicationId || interview.application.revision !== command.applicationRevision ||
            interview.roundType !== command.roundType || interview.startsAt !== command.startsAt ||
            interview.timeZone !== command.timeZone || interview.durationMin !== command.durationMin || interview.status !== 'scheduled') return fail();
        break;
      case 'edit':
        if (interview.roundType !== command.roundType || interview.durationMin !== command.durationMin) return fail();
        break;
      case 'reschedule':
        if (interview.startsAt !== command.startsAt || interview.timeZone !== command.timeZone || interview.status !== 'rescheduled') return fail();
        break;
      case 'status': if (interview.status !== command.status) return fail(); break;
      case 'delete': return fail();
    }
  }
  return Object.freeze({ interview, operation });
}
export async function changeInterviewRecord(client: InterviewRecordClient, value: InterviewIntent, signal?: AbortSignal) {
  current(client);
  const expected = expectation(value);
  const suffix = expected.action === 'reschedule' ? '/reschedule' : expected.action === 'status' ? '/status' : '';
  const method = expected.action === 'delete' ? 'DELETE' : expected.action === 'edit' ? 'PATCH' : 'POST';
  return result(client, await client.request(root + (expected.id ? '/' + expected.id : '') + suffix, {
    method, body: JSON.stringify(expected.body), signal,
  }), expected, false);
}
export async function observeInterviewRecord(client: InterviewRecordClient, value: InterviewIntent, signal?: AbortSignal) {
  current(client);
  const expected = expectation(value);
  return result(client, await client.request(root + '/operations/' + expected.command.operationId, { signal }), expected, true);
}
export type InterviewResult = Awaited<ReturnType<typeof changeInterviewRecord>>;
