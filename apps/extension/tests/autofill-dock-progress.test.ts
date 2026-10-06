import { describe, expect, it, vi } from 'vitest';
import type { AuditView } from '@edaix/apply-kernel/audit';

import { SIGN_ON_BEHALF_ENTRY_KEY } from '@edaix/apply-kernel/engine';
import { ALL_SIGN_ON_BEHALF_KINDS } from '@edaix/apply-kernel/signOnBehalf';

import { dockProgressFromAudit, SIGNED_ON_BEHALF } from '../lib/autofillDockProgress';

const row = (label: string, required: boolean, status: string) =>
  ({ key: null, label, required, status, reason: null, attemptedValue: null, resolvedOptionText: null }) as AuditView['rows'][number];
const view = (rows: AuditView['rows'], over: Partial<AuditView> = {}): AuditView =>
  ({ rows, filled: 0, requiredTotal: 0, requiredHandled: 0, needsAttention: 0, ...over }) as AuditView;

describe('dockProgressFromAudit', () => {
  it('carries the run so a sheet cannot be fed another run', () => {
    expect(dockProgressFromAudit('run-7', view([]))).toMatchObject({ runId: 'run-7' });
  });
  it('counts required progress the way the audit itself counts it', () => {
    const v = view([row('Full name', true, 'FILLED')], { requiredTotal: 3, requiredHandled: 2 });
    expect(dockProgressFromAudit('r', v)).toMatchObject({ requiredCompleted: 2, requiredQuestions: 3 });
  });
  it('treats a written-but-unconfirmed field as not done', () => {
    // The audit separates FILLED from FILLED_UNVERIFIED precisely so "clicked but
    // did not take" cannot look like "confirmed". The sheet must not re-merge them.
    const rows = dockProgressFromAudit('r', view([
      row('Confirmed', true, 'FILLED'),
      row('Unverified', true, 'FILLED_UNVERIFIED'),
      row('Rejected', true, 'REJECTED'),
      row('Failed', true, 'FAILED'),
    ])).rows;
    expect(rows.map((r) => [r.label, r.done])).toEqual([
      ['Confirmed', true], ['Unverified', false], ['Rejected', false], ['Failed', false],
    ]);
  });
  it('names each row the way the assistant does, and shows back only what was ours to write', () => {
    // The run scene speaks the assistant's vocabulary: confirmed, unverified,
    // preserved, manual, failed. Values travel only for rows we wrote, and the
    // rows only the user can finish are marked apart from the ones we failed.
    const rows = dockProgressFromAudit('r', view([
      { ...row('Name', true, 'FILLED'), attemptedValue: 'Ke Chen' },
      { ...row('Company', true, 'FILLED_UNVERIFIED'), attemptedValue: 'Acme' },
      { ...row('Email', true, 'PREFILLED'), attemptedValue: 'x@y.z' },
      { ...row('Referral', true, 'NEEDS_MANUAL'), reason: 'MANUAL_ONLY' as never },
      { ...row('Salary', false, 'MISSING_PROFILE'), reason: 'NO_VALUE' as never, attemptedValue: 'should-not-show' },
      { ...row('City', true, 'LOW_CONFIDENCE'), reason: 'LOW_CONFIDENCE' as never },
      { ...row('Phone', true, 'REJECTED'), reason: 'HOST_REJECTED' as never },
      row('LinkedIn', false, 'FAILED'),
    ])).rows;
    expect(rows.map((r) => [r.label, r.state, r.value ?? null, r.needsUser === true, r.reason])).toEqual([
      ['Name', 'CONFIRMED', 'Ke Chen', false, null],
      ['Company', 'UNVERIFIED', 'Acme', false, null],
      ['Email', 'PRESERVED', null, false, null],
      ['Referral', 'MANUAL', null, true, 'MANUAL_ONLY'],
      ['Salary', 'MANUAL', null, true, 'NO_VALUE'],
      ['City', 'MANUAL', null, true, 'LOW_CONFIDENCE'],
      ['Phone', 'FAILED', null, false, 'HOST_REJECTED'],
      ['LinkedIn', 'FAILED', null, false, null],
    ]);
  });
  it('网站从简历里读出来填上的一栏：照实带上来源，仍是「页面上已有」而不是要用户补的（2026-09-24）', () => {
    const [fromResume, alreadyThere] = dockProgressFromAudit('r', view([
      { ...row('Current Company', true, 'PREFILLED'), reason: 'NOT_EMPTY' as never, siteFilled: 'FROM_RESUME' },
      { ...row('Website', false, 'PREFILLED'), reason: 'NOT_EMPTY' as never },
    ])).rows;
    expect(fromResume).toMatchObject({ state: 'PRESERVED', fromResume: true });
    expect(fromResume?.needsUser).toBeUndefined();
    expect(alreadyThere?.fromResume, '本来就有的不说是简历里读的').toBeUndefined();
  });

  it('以用户名义代填的四个键带上类别，浮层据此明说「已替你…」（2026-09-23）', () => {
    const rows = dockProgressFromAudit('r', view([
      { ...row('By selecting the checkbox, you agree to our Terms', true, 'FILLED'), key: 'termsConsent' as never },
      { ...row('I certify the information is true', true, 'FILLED'), key: 'truthAttestation' as never },
      { ...row('Signature', true, 'FILLED'), key: 'signatureName' as never, attemptedValue: 'Ke Chen' },
      { ...row("Today's Date", true, 'NEEDS_MANUAL'), key: 'signatureDate' as never, reason: 'MANUAL_ONLY' as never },
      { ...row('Name', true, 'FILLED'), key: 'fullName' as never },
    ])).rows;
    expect(rows.map((r) => r.signedOnBehalf ?? null)).toEqual([
      'TERMS_CONSENT', 'TRUTH_ATTESTATION', 'SIGNATURE_NAME', 'SIGNATURE_DATE', null,
    ]);
  });

  it('六类同意（2026-09-24）的键也带上类别；没填成的照样带（浮层只把填成的算进代填）', () => {
    const rows = dockProgressFromAudit('r', view([
      { ...row('Do you consent to AI note-taking?', true, 'FILLED'), key: 'aiRecordingConsent' as never },
      { ...row('I agree to receive text messages', true, 'FILLED'), key: 'smsConsent' as never },
      { ...row('Join our talent community', false, 'FILLED'), key: 'futureContactConsent' as never },
      { ...row('I would like marketing emails', false, 'FILLED'), key: 'marketingConsent' as never },
      { ...row('Do you consent to a background check?', true, 'FILLED'), key: 'backgroundCheckConsent' as never },
      { ...row('Agreement to Arbitrate', true, 'NEEDS_MANUAL'), key: 'arbitrationAgreement' as never, reason: 'MANUAL_ONLY' as never },
    ])).rows;
    expect(rows.map((r) => [r.signedOnBehalf, r.state])).toEqual([
      ['AI_RECORDING_CONSENT', 'CONFIRMED'],
      ['SMS_CONSENT', 'CONFIRMED'],
      ['FUTURE_CONTACT_CONSENT', 'CONFIRMED'],
      ['MARKETING_CONSENT', 'CONFIRMED'],
      ['BACKGROUND_CHECK_CONSENT', 'CONFIRMED'],
      ['ARBITRATION_AGREEMENT', 'MANUAL'],
    ]);
  });

  it('第五刀的新类别与「能不能联系雇主」（2026-09-28）的键也带上类别', () => {
    const rows = dockProgressFromAudit('r', view([
      { ...row('I authorize a credit check', true, 'FILLED'), key: 'screeningConsent' as never },
      { ...row('May we contact your current employer?', true, 'FILLED'), key: 'employerContactDeclined' as never, attemptedValue: 'No' },
      { ...row('May we contact your references?', false, 'FILLED'), key: 'referenceContactAllowed' as never, attemptedValue: 'Yes' },
      { ...row('Applicant Privacy Notice', true, 'FILLED'), key: 'privacyNoticeAcknowledgement' as never },
    ])).rows;
    expect(rows.map((r) => r.signedOnBehalf)).toEqual(['SCREENING_CONSENT', 'EMPLOYER_CONTACT_NO', 'REFERENCE_CONTACT_YES', 'PRIVACY_NOTICE_TITLE']);
  });

  it('条目键 → 类别这张表与内核的「类别 → 条目键」互为反表：每一类都有，一类不多', () => {
    const inverse = Object.fromEntries(ALL_SIGN_ON_BEHALF_KINDS.map((kind) => [SIGN_ON_BEHALF_ENTRY_KEY[kind], kind]));
    expect(SIGNED_ON_BEHALF).toEqual(inverse);
  });

  it('按岗位地点推断出国家的工作授权答案：带上本地化的国名，浮层据此写明依据（2026-09-23）', () => {
    const [sponsorship, named] = dockProgressFromAudit('r', view([
      { ...row('Will you require sponsorship (e.g., H-1B)?', true, 'FILLED'), key: 'workSponsorship' as never, attemptedValue: 'No', inferredRegionCode: 'US' },
      { ...row('Are you authorized to work in the United States?', true, 'FILLED'), key: 'workAuthorization' as never, attemptedValue: 'Yes' },
    ])).rows;
    expect(sponsorship?.inferredRegion).toBe('美国');
    expect(named?.inferredRegion, '题目自己点名了国家的不是推断').toBeUndefined();
  });

  it('工作授权题说得出是哪一国、他在那一国没有记录：带上本地化的国名（2026-09-24）', () => {
    const [estonia, unknown] = dockProgressFromAudit('r', view([
      { ...row('Are you legally authorized to work in the country in which this role is located?', true, 'NEEDS_MANUAL'), reason: 'JOB_DEPENDENT' as never, regionWithoutRecord: 'EE' },
      { ...row('Do you require visa sponsorship?', true, 'NEEDS_MANUAL'), reason: 'JOB_DEPENDENT' as never },
    ])).rows;
    expect(estonia?.regionWithoutRecord).toBe('爱沙尼亚');
    expect(unknown?.regionWithoutRecord).toBeUndefined();
  });

  // 2026-09-24 负责人决定（Mike：「就答是的」）：他有别国的记录、唯独没有那一国的，工作授权按默认答（与 Jobright 一致）。
  it('按默认答的工作授权：带上本地化的国名与这一题是不是担保题，仍是我们填好的一行', () => {
    const [authorized, sponsorship, recorded] = dockProgressFromAudit('r', view([
      {
        ...row('Are you legally authorized to work in the country in which this role is located?', true, 'FILLED'),
        key: 'workAuthorization' as never, attemptedValue: 'Yes', inferredRegionCode: 'EE', defaultedRegionCode: 'EE',
      },
      {
        ...row('Will you now or in the future require sponsorship to work in Poland?', true, 'FILLED'),
        key: 'workSponsorship' as never, attemptedValue: 'No', defaultedRegionCode: 'PL',
      },
      { ...row('Are you authorized to work in the United States?', true, 'FILLED'), key: 'workAuthorization' as never, attemptedValue: 'Yes' },
    ])).rows;
    expect(authorized).toMatchObject({
      state: 'CONFIRMED', done: true, planned: true, value: 'Yes', defaultedWorkAuth: { region: '爱沙尼亚', sponsorship: false },
    });
    expect(authorized?.needsUser, '我们填好的，不是要他补的').toBeUndefined();
    expect(sponsorship?.defaultedWorkAuth).toEqual({ region: '波兰', sponsorship: true });
    expect(recorded?.defaultedWorkAuth, '按记录答的不是默认').toBeUndefined();
  });

  it('一段加了、填了、还没保存的经历：第几段（从 1 数）与保存钮上的字跟着行走（2026-09-24）', () => {
    const [entry] = dockProgressFromAudit('r', view([
      { ...row('Update', true, 'NEEDS_MANUAL'), reason: 'MANUAL_ONLY' as never, unsavedEntry: { collection: 'experience', rowIndex: 0 } },
    ])).rows;
    expect(entry?.unsavedEntry).toEqual({ collection: 'experience', number: 1, saveLabel: 'Update' });
    expect(entry?.needsUser).toBe(true);
  });

  it('全加全存（2026-09-24）：保存了的一段、没存上的一段（还差哪几格）、没加上的几段，都从 1 数', () => {
    const [saved, unsaved, unadded] = dockProgressFromAudit('r', view([
      { ...row('Update', true, 'FILLED'), attemptedValue: 'Data Analyst · Acme', savedEntry: { collection: 'experience', rowIndex: 0 } },
      { ...row('Update', true, 'NEEDS_MANUAL'), reason: 'NO_VALUE' as never, unsavedEntry: { collection: 'experience', rowIndex: 1, missing: ['Title'] } },
      { ...row('+ Add', true, 'NEEDS_MANUAL'), reason: 'NO_VALUE' as never, unaddedEntries: { collection: 'experience', from: 2, to: 3, afterUnsaved: true } },
    ])).rows;
    expect(saved).toMatchObject({ done: true, state: 'CONFIRMED', value: 'Data Analyst · Acme', savedEntry: { collection: 'experience', number: 1, saveLabel: 'Update' } });
    expect(unsaved?.unsavedEntry).toEqual({ collection: 'experience', number: 2, saveLabel: 'Update', missing: ['Title'] });
    expect(unadded?.unaddedEntries).toEqual({ collection: 'experience', from: 3, to: 4, afterUnsaved: true });
    expect(unadded?.needsUser).toBe(true);
  });

  it('按学历／工作经历推出来的答案：带上依据的稳定码，浮层据此写明是怎么推的（2026-09-24）', () => {
    const [adult, worked, explicit] = dockProgressFromAudit('r', view([
      { ...row('Are you at least 18 years of age?', true, 'FILLED'), key: 'over18' as never, attemptedValue: 'Yes', historyBasis: 'ADULT_FROM_HISTORY' },
      { ...row('Have you ever worked for Acme?', true, 'FILLED'), key: 'previouslyEmployedHere' as never, attemptedValue: 'No', historyBasis: 'EMPLOYER_NOT_IN_HISTORY' },
      { ...row('Are you 18 or older?', true, 'FILLED'), key: 'over18' as never, attemptedValue: 'Yes' },
    ])).rows;
    expect(adult?.historyBasis).toBe('ADULT_FROM_HISTORY');
    expect(worked?.historyBasis).toBe('EMPLOYER_NOT_IN_HISTORY');
    expect(explicit?.historyBasis, '档案里明确的值不是推出来的').toBeUndefined();
  });

  it('搜索式多选没加上的几项：值与稳定原因码原样带给浮层（2026-09-24，Workday 的技能）', () => {
    const misses = [{ value: 'Python', reason: 'AMBIGUOUS_OPTION' as const }, { value: 'Go', reason: 'ABORTED' as const }];
    const [skills, name] = dockProgressFromAudit('r', view([
      { ...row('Type to Add Skills', false, 'FILLED'), key: 'skills.all' as never, attemptedValue: 'SQL\nPython\nGo', notAdded: misses },
      { ...row('Name', true, 'FILLED'), attemptedValue: 'Ke Chen' },
    ])).rows;
    expect(skills?.notAdded).toEqual(misses);
    expect(skills?.value).toBe('SQL\nPython\nGo');
    expect(name).not.toHaveProperty('notAdded');
  });

  it('prefers the option text the plan resolved over the raw value for a select', () => {
    const [selected] = dockProgressFromAudit('r', view([
      { ...row('Country', true, 'FILLED'), attemptedValue: 'CN', resolvedOptionText: 'China' },
    ])).rows;
    expect(selected?.value).toBe('China');
  });
  it('carries a way to scroll the host field into view, and only when there is a field', () => {
    // Only scroll, never focus: focus would trigger the host's own validation
    // and linkage, and that is a change to host behaviour.
    const element = { scrollIntoView: vi.fn() };
    const [withField, without] = dockProgressFromAudit('r', view([
      { ...row('Name', true, 'NEEDS_MANUAL'), element: element as never } as never,
      row('Email', true, 'NEEDS_MANUAL'),
    ])).rows;
    expect(without?.locate).toBeUndefined();
    expect(withField?.locate).toBeTypeOf('function');
    withField?.locate?.();
    expect(element.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });
  it('keeps the required flag each row carries rather than inferring it', () => {
    const rows = dockProgressFromAudit('r', view([
      row('Full name', true, 'FILLED'), row('LinkedIn', false, 'FILLED'),
    ])).rows;
    expect(rows.map((r) => r.required)).toEqual([true, false]);
  });
});
