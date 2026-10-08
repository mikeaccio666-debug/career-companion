import { parseCareerInterviewCommand, type CareerApplicationSummary, type CareerInterview, type CareerInterviewRoundType, type CareerInterviewStatus } from '@companion/platform-contracts';
import { interviewLocalInput, resolveInterviewTime } from './career-interview-time.ts';
import { freezeInterviewIntent, type InterviewIntent } from './career-interview-api.ts';

export const interviewRoundLabels: Readonly<Record<CareerInterviewRoundType, string>> = Object.freeze({
  coding: '编程', system_design: '系统设计', ml_design: '机器学习设计', sql: 'SQL',
  stats: '统计', product_case: '产品 / 案例', behavioral: '行为面试',
  hiring_manager: 'Hiring manager', bug_bash: 'Bug bash', take_home: 'Take-home',
});
export const interviewStatusLabels: Readonly<Record<CareerInterviewStatus, string>> = Object.freeze({
  scheduled: '已记下', rescheduled: '已改期', done: '已面完', cancelled: '已取消',
});
export interface InterviewEditor {
  readonly kind: 'create' | 'edit' | 'reschedule';
  readonly record: Readonly<CareerInterview> | null;
  readonly applicationId: string;
  readonly roundType: CareerInterviewRoundType | '';
  readonly duration: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly selectedInstant: string;
  readonly confirmed: boolean;
}
export function interviewDraft(kind: InterviewEditor['kind'], record: Readonly<CareerInterview> | null = null): InterviewEditor {
  return {
    kind, record, applicationId: record?.application.id ?? '', roundType: record?.roundType ?? '',
    duration: record ? String(record.durationMin) : '', localTime: record ? interviewLocalInput(record.startsAt, record.timeZone) : '',
    timeZone: record?.timeZone ?? '', selectedInstant: record?.startsAt ?? '', confirmed: false,
  };
}
/** Pure form-to-command boundary. Only an explicitly selected overlap instant is used. */
export function interviewEditorIntent(editor: InterviewEditor, applications: readonly Readonly<CareerApplicationSummary>[], operationId: string): Readonly<InterviewIntent> {
  if (!editor.confirmed) throw Error('请先核对并确认这次记录。');
  if (editor.kind !== 'create' && !editor.record) throw Error('请重新读取这条面试。');
  const base = { operationId, expectedRevision: editor.record?.revision ?? 0 };
  const durationMin = Number(editor.duration);
  if (editor.kind !== 'reschedule' && (!/^[1-9][0-9]*$/.test(editor.duration) || !Number.isSafeInteger(durationMin))) throw Error('请填写正整数时长，不确定时可以先取消。');
  let startsAt = '';
  if (editor.kind !== 'edit') {
    const resolution = resolveInterviewTime(editor.localTime, editor.timeZone);
    if (resolution.kind === 'invalid' || resolution.kind === 'gap') throw Error(resolution.message);
    startsAt = resolution.candidates.length === 1 ? resolution.candidates[0].startsAt : editor.selectedInstant;
    if (!resolution.candidates.some(c => c.startsAt === startsAt)) throw Error('这个时间出现两次，请选择对应的 UTC 偏移量。');
  }
  let body: unknown;
  if (editor.kind === 'create') {
    const source = applications.find(a => a.id === editor.applicationId);
    if (!source) throw Error('请先选择你自己的投递记录。');
    body = { ...base, applicationId: source.id, applicationRevision: source.revision, roundType: editor.roundType, startsAt, timeZone: editor.timeZone, durationMin };
  } else if (editor.kind === 'edit') body = { ...base, roundType: editor.roundType, durationMin };
  else body = { ...base, startsAt, timeZone: editor.timeZone };
  parseCareerInterviewCommand(editor.kind, body);
  return freezeInterviewIntent({ action: editor.kind, id: editor.record?.id ?? null, body });
}
