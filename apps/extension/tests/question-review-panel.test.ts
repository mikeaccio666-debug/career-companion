// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyWriteResult } from '@edaix/apply-kernel/contracts';
import type { ApplicationQuestionResultV1, ApplicationQuestionSettingsV1 } from '@edaix/contracts';
import { renderQuestionReview, type QuestionReviewHandlers } from '../lib/questionReviewPanel';

/**
 * Independent review of #310 (2026-09-10): a candidate load that finished after the user
 * disabled the feature restored a live fill button with the old values, and row state
 * survived across reloads. Every stale result below must leave nothing fillable behind.
 */
const question = { questionId: 'q0', text: 'Why do you want to work here?', controlType: 'TEXTAREA' as const, required: true, options: [], fieldName: 'question_0' };
const settings = (enabled: boolean, revision = '1'): ApplicationQuestionSettingsV1 =>
  ({ schemaVersion: 1, enabled, autoReuse: false, revision, disclosureVersion: '2026-09-10' } as ApplicationQuestionSettingsV1);
const candidates = (text: string): ApplicationQuestionResultV1 => ({
  schemaVersion: 1, ok: true, requestId: '00000000-0000-4000-8000-000000000001', persisted: false, deliveryAuthorized: false,
  context: { extensionInstallId: 'i', missionId: 'm', missionRevision: '1', canonicalJobId: 'j', applicationBundleVersion: '1', applicationTargetRevision: '1', pageId: 'p', pageGeneration: '1' },
  candidates: [{ questionId: 'q0', disposition: 'REVIEW_REQUIRED', reasonCode: 'EVIDENCE_BOUND', answer: { kind: 'TEXT', text }, confidence: 'LOW', provenance: [] }],
} as unknown as ApplicationQuestionResultV1);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function mount(overrides: Partial<QuestionReviewHandlers> = {}) {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  document.body.append(host);
  const answer = vi.fn(async () => []);
  const handlers: QuestionReviewHandlers = {
    questions: [question],
    loadSettings: async () => settings(true),
    updateSettings: async (update) => settings(update.enabled, '2'),
    fetchCandidates: async () => candidates('Old candidate'),
    answer,
    remember: async () => false,
    ...overrides,
  };
  const panel = renderQuestionReview(document, shadow, handlers);
  shadow.append(panel);
  return { panel, shadow, answer, enable: () => panel.querySelector<HTMLInputElement>('input[type=checkbox]')! };
}

const fillButton = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('回填')) ?? null;

beforeEach(() => {
  // happy-dom has no Option constructor; the panel only needs a DOM-equivalent one.
  vi.stubGlobal('Option', function (text: string, value = text, _defaultSelected = false, selected = false) {
    const option = document.createElement('option');
    option.text = text; option.value = value; option.selected = selected; return option;
  });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('question review panel retires stale candidate loads', () => {
  it('a load that finishes after the feature was disabled leaves no fill button and no rows', async () => {
    const pending = deferred<ApplicationQuestionResultV1>();
    const { panel, enable, answer } = mount({ fetchCandidates: () => pending.promise });
    await settle();
    enable().checked = false;
    enable().dispatchEvent(new Event('change'));
    await settle();
    pending.resolve(candidates('Old candidate'));
    await settle();
    expect(enable().checked).toBe(false);
    expect(fillButton(panel)).toBeNull();
    expect(panel.querySelectorAll('.question')).toHaveLength(0);
    expect(answer).not.toHaveBeenCalled();
  });

  it('an older load that returns after a newer one is ignored and rows are not duplicated', async () => {
    const first = deferred<ApplicationQuestionResultV1>();
    const second = deferred<ApplicationQuestionResultV1>();
    let calls = 0;
    const { panel, enable } = mount({ fetchCandidates: () => (calls++ === 0 ? first.promise : second.promise) });
    await settle();
    // Toggling the feature off and on starts a second load while the first is still pending.
    enable().checked = false; enable().dispatchEvent(new Event('change')); await settle();
    enable().checked = true; enable().dispatchEvent(new Event('change')); await settle();
    second.resolve(candidates('New candidate'));
    await settle();
    first.resolve(candidates('Old candidate'));
    await settle();
    const rows = panel.querySelectorAll<HTMLTextAreaElement>('.question textarea');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('New candidate');
  });

  it('a failed latest load shows the failure and leaves nothing fillable from before', async () => {
    let calls = 0;
    const { panel, enable } = mount({
      fetchCandidates: async () => (calls++ === 0 ? candidates('Old candidate') : ({ schemaVersion: 1, ok: false, code: 'QUESTION_CONTEXT_STALE' } as ApplicationQuestionResultV1)),
    });
    await settle();
    expect(fillButton(panel)).not.toBeNull();
    enable().checked = false; enable().dispatchEvent(new Event('change')); await settle();
    enable().checked = true; enable().dispatchEvent(new Event('change')); await settle();
    expect(fillButton(panel)).toBeNull();
    expect(panel.querySelectorAll('.question')).toHaveLength(0);
    expect(panel.querySelector('.questions-status')?.textContent).toContain('QUESTION_CONTEXT_STALE');
  });

  it('a load that finishes after the panel was dismissed renders nothing', async () => {
    const pending = deferred<ApplicationQuestionResultV1>();
    const { panel } = mount({ fetchCandidates: () => pending.promise });
    await settle();
    panel.remove();
    pending.resolve(candidates('Old candidate'));
    await settle();
    expect(fillButton(panel)).toBeNull();
    expect(panel.querySelectorAll('.question')).toHaveLength(0);
  });

  it('submitting re-checks that the feature is still enabled', async () => {
    const { panel, enable, answer } = mount();
    await settle();
    const fill = fillButton(panel)!;
    enable().checked = false;
    fill.click();
    await settle();
    expect(answer).not.toHaveBeenCalled();
  });
});

/**
 * Independent review round 2 (2026-09-10): after the write returned, the panel re-read the
 * value and scope from the live inputs, so an edit made while the write was pending was
 * remembered although it was never confirmed. The click now captures the whole snapshot.
 */
describe('question review panel remembers only what the click confirmed', () => {
  const ok = (questionId: string): readonly ApplyWriteResult[] => [{ key: `question:${questionId}`, label: '', ok: true }];

  it('remembers the value and scope captured at the click, not later edits', async () => {
    const pending = deferred<readonly ApplyWriteResult[]>();
    const remember = vi.fn(async () => true);
    const { panel } = mount({ answer: vi.fn(() => pending.promise), remember });
    await settle();
    const input = panel.querySelector<HTMLTextAreaElement>('.question textarea')!;
    const scope = panel.querySelector<HTMLSelectElement>('.question select')!;
    scope.selectedIndex = 2; // 这个岗位 → JOB
    fillButton(panel)!.click();
    await settle();
    expect(input.disabled).toBe(true);
    input.disabled = false; input.value = 'Edited while pending';
    scope.disabled = false; scope.selectedIndex = 3;
    pending.resolve(ok('q0'));
    await settle();
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ value: 'Old candidate', scope: 'JOB', answerClass: 'JOB_SPECIFIC' }));
  });

  it('passes the same snapshot to the write and to the memory', async () => {
    const answer = vi.fn(async () => ok('q0'));
    const remember = vi.fn(async () => true);
    const { panel } = mount({ answer, remember });
    await settle();
    const input = panel.querySelector<HTMLTextAreaElement>('.question textarea')!;
    input.value = 'Confirmed by me';
    panel.querySelector<HTMLSelectElement>('.question select')!.selectedIndex = 3; // 所有申请 → USER
    fillButton(panel)!.click();
    await settle();
    expect(answer).toHaveBeenCalledWith(expect.anything(), expect.anything(), [{ questionId: 'q0', value: 'Confirmed by me' }], expect.anything());
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ value: 'Confirmed by me', scope: 'USER', answerClass: 'PROFILE_STABLE' }));
  });

  it('saves nothing when the panel was retired while the write was pending', async () => {
    const pending = deferred<readonly ApplyWriteResult[]>();
    const remember = vi.fn(async () => true);
    const { panel, enable } = mount({ answer: vi.fn(() => pending.promise), remember });
    await settle();
    panel.querySelector<HTMLSelectElement>('.question select')!.selectedIndex = 2;
    fillButton(panel)!.click();
    await settle();
    enable().checked = false; enable().dispatchEvent(new Event('change'));
    await settle();
    pending.resolve(ok('q0'));
    await settle();
    expect(remember).not.toHaveBeenCalled();
  });
});

/**
 * Independent review round 3 (2026-09-10): the memory request dropped the confirmed context, and
 * a load retired while the first save was pending still sent the second save. The request now
 * carries the snapshot's context, and retirement is re-checked before and after every save.
 */
describe('question review panel saves under the confirmed context and stops when retired', () => {
  const two = [question, { questionId: 'q1', text: 'What is your notice period?', controlType: 'TEXT' as const, required: false, options: [], fieldName: 'question_1' }];
  const twoCandidates = (): ApplicationQuestionResultV1 => ({
    ...(candidates('Old candidate') as { candidates: readonly unknown[] }),
    candidates: [
      ...(candidates('Old candidate') as { candidates: readonly unknown[] }).candidates,
      { questionId: 'q1', disposition: 'REVIEW_REQUIRED', reasonCode: 'EVIDENCE_BOUND', answer: { kind: 'TEXT', text: 'Two weeks' }, confidence: 'LOW', provenance: [] },
    ],
  } as unknown as ApplicationQuestionResultV1);
  const wrote = (): readonly ApplyWriteResult[] => [{ key: 'question:q0', label: '', ok: true }, { key: 'question:q1', label: '', ok: true }];

  it('passes the load context of the click to every memory request', async () => {
    const remember = vi.fn(async () => true);
    const { panel } = mount({ questions: two, fetchCandidates: async () => twoCandidates(), answer: async () => wrote(), remember });
    await settle();
    for (const select of panel.querySelectorAll<HTMLSelectElement>('.question select')) select.selectedIndex = 1;
    fillButton(panel)!.click();
    await settle();
    expect(remember).toHaveBeenCalledTimes(2);
    for (const call of remember.mock.calls as unknown as [{ context: unknown; question: { questionId: string } }][]) {
      expect(call[0].context).toEqual((twoCandidates() as Extract<ApplicationQuestionResultV1, { ok: true }>).context);
    }
    expect((remember.mock.calls as unknown as [{ question: { questionId: string } }][]).map((call) => call[0].question.questionId)).toEqual(['q0', 'q1']);
  });

  it('stops saving further answers when the load is retired while the first save is pending', async () => {
    const first = deferred<boolean>();
    const remember = vi.fn(() => first.promise);
    const { panel } = mount({ questions: two, fetchCandidates: async () => twoCandidates(), answer: async () => wrote(), remember });
    await settle();
    for (const select of panel.querySelectorAll<HTMLSelectElement>('.question select')) select.selectedIndex = 1;
    fillButton(panel)!.click();
    await settle();
    expect(remember).toHaveBeenCalledTimes(1);
    // Changing auto-reuse re-saves the settings and starts a new load while the first save is pending.
    const autoReuse = panel.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1]!;
    autoReuse.checked = true; autoReuse.dispatchEvent(new Event('change'));
    await settle();
    first.resolve(true);
    await settle();
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('stops saving further answers when the panel is dismissed while a save is pending', async () => {
    const first = deferred<boolean>();
    const remember = vi.fn(() => first.promise);
    const { panel } = mount({ questions: two, fetchCandidates: async () => twoCandidates(), answer: async () => wrote(), remember });
    await settle();
    for (const select of panel.querySelectorAll<HTMLSelectElement>('.question select')) select.selectedIndex = 1;
    fillButton(panel)!.click();
    await settle();
    panel.remove();
    first.resolve(true);
    await settle();
    expect(remember).toHaveBeenCalledTimes(1);
  });
});

/** Closed choices are shown the way the host asks them: one checkbox per option, submitted one per line. */
describe('question review panel renders multi-choice questions as checkboxes', () => {
  const multi = { questionId: 'q0', text: 'Which of these have you worked with?', controlType: 'MULTI_CHOICE' as const, required: true,
    options: [{ optionId: 'o0', text: 'TypeScript' }, { optionId: 'o1', text: 'Python' }, { optionId: 'o2', text: 'Rust' }], fieldName: 'question_0[]' };
  const chosen = (): ApplicationQuestionResultV1 => ({
    ...candidates(''),
    candidates: [{ questionId: 'q0', disposition: 'REVIEW_REQUIRED', reasonCode: 'EVIDENCE_BOUND', answer: { kind: 'CHOICES', optionIds: ['o0', 'o2'] }, confidence: 'LOW', provenance: [] }],
  } as unknown as ApplicationQuestionResultV1);

  it('pre-checks the candidate options and submits exactly the boxes the user left checked', async () => {
    const answer = vi.fn(async (): Promise<readonly ApplyWriteResult[]> => [{ key: 'question:q0', label: '', ok: true }]);
    const { panel } = mount({ questions: [multi], fetchCandidates: async () => chosen(), answer });
    await settle();
    const boxes = [...panel.querySelectorAll<HTMLInputElement>('.question .choices input[type=checkbox]')];
    expect(boxes.map((box) => [box.value, box.checked])).toEqual([['TypeScript', true], ['Python', false], ['Rust', true]]);
    boxes[0]!.checked = false;
    boxes[1]!.checked = true;
    fillButton(panel)!.click();
    await settle();
    expect(answer).toHaveBeenCalledWith(expect.anything(), expect.anything(), [{ questionId: 'q0', value: 'Python\nRust' }], expect.anything());
  });
});

/**
 * 手势路（P1-6）：候选来自本地记忆比对，没有 Mission 上下文；「记住」只给「不记住 / 所有申请」
 * 两档；披露文案要另说一句（题目不上传）。
 */
describe('question review panel on the gesture lane', () => {
  it('renders the caller\'s disclosure and only the offered scopes, and hands a null context back', async () => {
    const answer = vi.fn(async () => [{ key: 'question:q0' as const, label: '', ok: true as const }]);
    const remember = vi.fn(async () => true);
    const { panel, enable } = mount({
      fetchCandidates: async () => ({ ok: true as const, context: null, candidates: [{ questionId: 'q0', disposition: 'USER_CONFIRMATION_REQUIRED', reasonCode: 'QUESTION_CONFIRMED_ANSWER' as never, answer: { kind: 'TEXT', text: 'Because payments.' }, confidence: 'HIGH', provenance: [] }] }),
      answer, remember,
      disclosure: '只在本地比对',
      scopeChoices: ['', 'USER'],
    });
    expect(panel.querySelector('.questions-note')?.textContent).toBe('只在本地比对');
    enable().checked = true; enable().dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const scope = panel.querySelector<HTMLSelectElement>('.question select')!;
    expect([...scope.options].map((option) => option.text)).toEqual(['不记住', '所有申请']);
    scope.selectedIndex = 1;
    fillButton(panel)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answer).toHaveBeenCalledWith(expect.anything(), expect.anything(), [{ questionId: 'q0', value: 'Because payments.' }], null);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ scope: 'USER', answerClass: 'PROFILE_STABLE', context: null }));
  });
});

/**
 * 档案预填（自我认同 / 工作授权，PREFILLED_NEEDS_CONFIRMATION）不依赖记忆开关：
 * 没打开记忆也摆出来预选好，用户点头才写；同一题有预填就不看记忆候选。
 */
describe('档案预填不用打开记忆也摆出来', () => {
  const gender = {
    questionId: 'q1', text: 'Gender', controlType: 'SINGLE_CHOICE' as const, required: true,
    options: [{ optionId: 'o1', text: 'Male' }, { optionId: 'o2', text: 'Female' }], fieldName: 'gender',
  };

  it('记忆关着：预填的题预选好、有回填按钮、只剩「不记住」一档；候选接口一次都不调；没预填的题不出现', async () => {
    const fetchCandidates = vi.fn(async () => candidates('x'));
    const { panel, answer } = mount({
      questions: [question, gender], loadSettings: async () => settings(false), fetchCandidates,
      prefills: new Map([['q1', 'Female']]), scopeChoices: ['', 'USER'],
    });
    await settle();
    expect(fetchCandidates).not.toHaveBeenCalled();
    const rowsRendered = panel.querySelectorAll('.question');
    expect(rowsRendered).toHaveLength(1);
    const [control, scope] = [...rowsRendered[0]!.querySelectorAll('select')];
    expect(control?.value).toBe('Female');
    expect([...scope!.options].map((option) => option.text)).toEqual(['不记住']);
    expect(rowsRendered[0]?.textContent).toContain('来自你的资料或记忆，请确认');
    fillButton(panel)!.click();
    await settle();
    expect(answer).toHaveBeenCalledWith(expect.anything(), expect.anything(), [{ questionId: 'q1', value: 'Female' }], null);
  });

  it('记忆开着：有预填的题用预填，其余题用记忆候选', async () => {
    const { panel } = mount({
      questions: [question, gender], loadSettings: async () => settings(true),
      fetchCandidates: async () => candidates('Old candidate'),
      prefills: new Map([['q1', 'Female']]),
    });
    await settle();
    const rowsRendered = [...panel.querySelectorAll('.question')];
    expect(rowsRendered).toHaveLength(2);
    expect(rowsRendered[0]?.querySelector('textarea')?.value).toBe('Old candidate');
    expect(rowsRendered[1]?.querySelector('select')?.value).toBe('Female');
  });

  it('预填带来源说明（按岗位地点推断）→ 写在提示里，用户点头前看得见', async () => {
    const work = { questionId: 'q2', text: 'Are you authorized to work in the country in which this job is based?', controlType: 'SINGLE_CHOICE' as const, required: true, options: [{ optionId: 'y', text: 'Yes' }, { optionId: 'n', text: 'No' }], fieldName: 'work' };
    const { panel } = mount({
      questions: [work], loadSettings: async () => settings(false),
      prefills: new Map([['q2', 'Yes']]), prefillNotes: new Map([['q2', '按岗位地点（美国）推断']]),
    });
    await settle();
    const row = panel.querySelector('.question')!;
    expect(row.querySelector('select')?.value).toBe('Yes');
    expect(row.textContent).toContain('来自你的资料或记忆，请确认（按岗位地点（美国）推断）');
  });

  it('没有预填、记忆关着：什么都不摆，与从前一样', async () => {
    const { panel } = mount({ questions: [question, gender], loadSettings: async () => settings(false) });
    await settle();
    expect(panel.querySelectorAll('.question')).toHaveLength(0);
    expect(fillButton(panel)).toBeNull();
  });
});

describe('AI 起草开放题（P3-13）', () => {
  it('记忆关着也给「让 AI 起草」；点了才发；草稿摆成可编辑的一行，改完回填的是改后的文字', async () => {
    const fetchDrafts = vi.fn(async () => ({ ok: true as const, drafts: new Map([['q0', 'I want to join because…']]) }));
    const { panel, shadow, answer } = mount({
      loadSettings: async () => settings(false),
      fetchCandidates: async () => null,
      fetchDrafts,
    });
    await settle();
    const draftButton = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('让 AI 起草'));
    expect(draftButton?.textContent).toContain('1 题');
    expect(draftButton?.textContent, '按钮上写明题目与岗位会上行').toContain('发送到 EdAIX');
    expect(fetchDrafts, '没点之前不发').not.toHaveBeenCalled();
    expect(fillButton(panel)).toBeNull();
    draftButton?.click();
    await settle();
    expect(fetchDrafts).toHaveBeenCalledTimes(1);
    const control = panel.querySelector<HTMLTextAreaElement>('textarea');
    expect(control?.value).toBe('I want to join because…');
    expect(panel.textContent).toContain('AI 草稿，请审阅后回填');
    control!.value = 'I want to join because I edited this.';
    fillButton(panel)!.click();
    await settle();
    expect(answer).toHaveBeenCalledWith(expect.anything(), shadow, [{ questionId: 'q0', value: 'I want to join because I edited this.' }], null);
  });

  it('起草失败只说码，按钮可以再点；没连上说没连上', async () => {
    let calls = 0;
    const { panel } = mount({
      loadSettings: async () => settings(false),
      fetchCandidates: async () => null,
      fetchDrafts: async () => (calls++ === 0 ? { ok: false as const, code: 'QUOTA_EXCEEDED' } : null),
    });
    await settle();
    const button = () => [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('让 AI 起草'))!;
    button().click();
    await settle();
    expect(panel.textContent).toContain('没能起草（QUOTA_EXCEEDED）');
    expect(button().disabled).toBe(false);
    button().click();
    await settle();
    expect(panel.textContent).toContain('没能连上 EdAIX');
  });

  it('不是开放题就没有这颗按钮', async () => {
    const { panel } = mount({
      questions: [{ ...question, controlType: 'TEXT' as const }],
      loadSettings: async () => settings(false),
      fetchCandidates: async () => null,
      fetchDrafts: async () => null,
    });
    await settle();
    expect([...panel.querySelectorAll<HTMLButtonElement>('button')].some((b) => b.textContent?.includes('让 AI 起草'))).toBe(false);
  });
});
