import type { ApplyWriteResult } from '@edaix/apply-kernel/contracts';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';
import type {
  ApplicationQuestionAnswerClass,
  ApplicationQuestionCandidateV1,
  ApplicationQuestionContextV1,
  ApplicationQuestionMemoryScope,
  ApplicationQuestionResultV1,
  ApplicationQuestionSettingsUpdateV1,
  ApplicationQuestionSettingsV1,
} from '@edaix/contracts';

/**
 * 审计面板里的「还有几题没填」区：开关 + 披露 → 后端候选 → 用户逐题确认/修改 →
 * 一键回填 → 勾选的答案记住。答案只在用户确认后写入宿主，写入走 kernel 的
 * 计划/授权/撤销链（信任根是用户在本 shadow 里的真实点击）。
 */
export interface ReviewedAnswer {
  readonly questionId: string;
  readonly value: string;
}

export interface RememberRequest {
  readonly question: QuestionDescription;
  readonly value: string;
  readonly scope: ApplicationQuestionMemoryScope;
  readonly answerClass: ApplicationQuestionAnswerClass;
  /**
   * The context the candidates were generated and the answer confirmed under; the memory is
   * filed under this one only. `null` on the gesture lane: it has no Mission, and its memory
   * wire keys answers by question identity alone.
   */
  readonly context: ApplicationQuestionContextV1 | null;
}

/** 候选一次装载。mission 路是后端的 ResultV1；手势路是本地记忆比对出来的同形状（context 为 null）。 */
export type CandidateLoad =
  | Readonly<{ ok: true; context: ApplicationQuestionContextV1 | null; candidates: readonly ApplicationQuestionCandidateV1[] }>
  | Readonly<{ ok: false; code: string }>;

export interface QuestionReviewHandlers {
  readonly questions: readonly QuestionDescription[];
  readonly loadSettings: () => Promise<ApplicationQuestionSettingsV1 | null>;
  readonly updateSettings: (update: ApplicationQuestionSettingsUpdateV1) => Promise<ApplicationQuestionSettingsV1 | null>;
  readonly fetchCandidates: (questions: readonly QuestionDescription[]) => Promise<CandidateLoad | ApplicationQuestionResultV1 | null>;
  /** `context` is the one the candidates were generated under, so the caller can confirm it is still current before writing. */
  readonly answer: (event: Event, shadowRoot: ShadowRoot, answers: readonly ReviewedAnswer[], context: ApplicationQuestionContextV1 | null) => Promise<readonly ApplyWriteResult[]>;
  readonly remember: (request: RememberRequest) => Promise<boolean>;
  /** 披露文案；缺省是 mission 路那句（题目会上行到后端生成候选）。手势路的候选只在本地比对，要另说一句。 */
  readonly disclosure?: string;
  /** 「记住」下拉里给哪几档；缺省全部四档。手势路的 wire 没有岗位/单次两档，只给「不记住 / 所有申请」。 */
  readonly scopeChoices?: readonly (ApplicationQuestionMemoryScope | '')[];
  /**
   * 计划期已经替用户选好、只等他点头的答案（按岗位地点推断的工作授权，PREFILLED_NEEDS_CONFIRMATION；
   * 2026-09-21 起 EEO 等档案里亲手填的值直接写，不再经这里）：
   * 题目 id → 建议选项原文。这些题**不依赖记忆开关**：没打开记忆也摆出来预选好，用户确认才写；
   * 同一题有预填就不再看记忆候选——档案是他自己确认过的事实，比记忆新。
   */
  readonly prefills?: ReadonlyMap<string, string>;
  /** 预填答案的来源说明（题目 id → 一句话，如「按岗位地点（美国）推断」），跟在提示后面显示。 */
  readonly prefillNotes?: ReadonlyMap<string, string>;
  /**
   * AI 起草开放题（P3-13）。给了它，面板就在还没有答案的开放题（TEXTAREA）下面出一颗
   * 「让 AI 起草」——用户点了才发（题目与岗位会上行，按钮文案写明）；草稿摆成可编辑的一行，
   * 与其它候选一样要他点「回填」才写，勾了「记住」才存。
   */
  readonly fetchDrafts?: (questions: readonly QuestionDescription[]) => Promise<DraftLoad>;
}

/** 起草一次装载：题目 id → 草稿；失败带稳定码；null = 没连上。 */
export type DraftLoad =
  | Readonly<{ ok: true; drafts: ReadonlyMap<string, string> }>
  | Readonly<{ ok: false; code: string }>
  | null;

/** Version of the disclosure text below; bump when the wording changes materially. */
export const QUESTION_DISCLOSURE_VERSION = '2026-09-10';
const DISCLOSURE = '开启后，这些题目、选项和岗位会发送到 EdAIX 后端，用你的资料和简历生成候选答案。答案只在你确认后写入，勾选「记住」才会保存。';

const SCOPE_OPTIONS: ReadonlyArray<readonly [ApplicationQuestionMemoryScope | '', string, ApplicationQuestionAnswerClass | '']> = [
  ['', '不记住', ''],
  ['APPLICATION', '只这次申请', 'APPLICATION_INSTANCE'],
  ['JOB', '这个岗位', 'JOB_SPECIFIC'],
  ['USER', '所有申请', 'PROFILE_STABLE'],
];

const HINT: Readonly<Record<ApplicationQuestionCandidateV1['disposition'], string>> = {
  REVIEW_REQUIRED: 'AI 草稿，请审阅后回填',
  USER_CONFIRMATION_REQUIRED: '来自你的资料或记忆，请确认',
  DURABLE_RELEASE_REQUIRED: '需要你本人授权，请在页面上处理',
  NEEDS_USER_INPUT: '没有依据，请你填写',
  USER_ONLY: '只能你本人在页面上处理',
};

export function renderQuestionReview(doc: Document, shadow: ShadowRoot, handlers: QuestionReviewHandlers): HTMLElement {
  const section = doc.createElement('div');
  section.className = 'questions';
  const head = doc.createElement('div');
  head.className = 'questions-head';
  head.textContent = `还有 ${handlers.questions.length} 题没填`;
  const status = doc.createElement('span');
  status.className = 'questions-status';
  const enable = doc.createElement('input');
  enable.type = 'checkbox';
  const autoReuse = doc.createElement('input');
  autoReuse.type = 'checkbox';
  const toggle = doc.createElement('label');
  toggle.append(enable, doc.createTextNode('让 EdAIX 用我的资料帮我答这些题'));
  const reuse = doc.createElement('label');
  reuse.append(autoReuse, doc.createTextNode('自动带出我记住的答案'));
  const disclosure = doc.createElement('span');
  disclosure.className = 'questions-note';
  disclosure.textContent = handlers.disclosure ?? DISCLOSURE;
  const scopeOptions = SCOPE_OPTIONS.filter(([scope]) => handlers.scopeChoices === undefined || handlers.scopeChoices.includes(scope));
  const list = doc.createElement('div');
  list.className = 'questions-list';
  section.append(head, toggle, reuse, disclosure, list, status);

  const rows = new Map<string, QuestionRow>();

  // Only the newest load may render, and only while the feature is still on and the panel is
  // still on screen. Disabling, dismissing or reloading retires everything pending, so a late
  // result can never leave a fillable answer behind.
  let generation = 0;
  let loaded: { generation: number; context: ApplicationQuestionContextV1 | null } | null = null;
  const retire = () => {
    generation += 1;
    loaded = null;
    rows.clear();
    list.replaceChildren();
  };

  const prefills = handlers.prefills ?? new Map<string, string>();
  // AI 草稿（P3-13）：用户点过「让 AI 起草」之后留在这里，重载时照样摆出来；开关与它无关。
  const drafted = new Map<string, string>();
  const openText = handlers.questions.filter((question) => question.controlType === 'TEXTAREA');
  const draftable = handlers.fetchDrafts !== undefined && openText.length > 0;
  const load = async () => {
    retire();
    const mine = generation;
    // 记忆开着才去取候选；没开但有档案预填的题（自我认同 / 工作授权），照样摆出来等他点头。
    let fetched: readonly ApplicationQuestionCandidateV1[] = [];
    let context: ApplicationQuestionContextV1 | null = null;
    if (enable.checked) {
      status.textContent = '正在生成候选答案…';
      const result = await handlers.fetchCandidates(handlers.questions);
      if (mine !== generation || !enable.checked || !section.isConnected) return;
      if (!result || !result.ok) {
        status.textContent = result ? `没能生成候选（${result.code}）` : '没能连上 EdAIX，稍后再试';
        return;
      }
      fetched = result.candidates;
      context = result.context;
    }
    status.textContent = '';
    loaded = { generation: mine, context };
    // 记忆没开就只剩「不记住」一档：这一次点头不该顺手把答案存进账号。
    const memoryScopes = enable.checked ? scopeOptions : scopeOptions.slice(0, 1);
    for (const question of handlers.questions) {
      const prefill = prefills.get(question.questionId);
      const draft = drafted.get(question.questionId);
      const candidate = prefill !== undefined
        ? prefillCandidate(question, prefill)
        : draft !== undefined
          ? draftCandidate(question, draft)
          : fetched.find((item) => item.questionId === question.questionId);
      if (!candidate || candidate.disposition === 'USER_ONLY' || candidate.disposition === 'DURABLE_RELEASE_REQUIRED') continue;
      list.append(renderQuestion(doc, question, candidate, rows, memoryScopes, handlers.prefillNotes?.get(question.questionId)));
    }
    // 还没有答案的开放题：给一颗「让 AI 起草」。用户点了才发，题目与岗位会上行，写在按钮上。
    const pending = draftable ? openText.filter((question) => !rows.has(question.questionId)) : [];
    if (rows.size === 0 && pending.length === 0) {
      status.textContent = enable.checked ? '这些题都需要你本人在页面上处理。' : '';
      return;
    }
    if (rows.size > 0) {
      const fill = doc.createElement('button');
      fill.type = 'button';
      fill.textContent = '回填已确认的答案';
      fill.addEventListener('click', (event) => { void submit(event, fill, mine); });
      list.append(fill);
    }
    if (pending.length > 0 && handlers.fetchDrafts !== undefined) {
      const fetchDrafts = handlers.fetchDrafts;
      const draftButton = doc.createElement('button');
      draftButton.type = 'button';
      draftButton.textContent = `让 AI 起草 ${pending.length} 题（题目与岗位会发送到 EdAIX）`;
      draftButton.addEventListener('click', () => {
        void (async () => {
          draftButton.disabled = true;
          status.textContent = '正在起草…';
          const result = await fetchDrafts(pending);
          if (mine !== generation || !section.isConnected) return;
          if (!result || !result.ok) {
            status.textContent = result ? `没能起草（${result.code}）` : '没能连上 EdAIX，稍后再试';
            draftButton.disabled = false;
            return;
          }
          for (const [questionId, text] of result.drafts) drafted.set(questionId, text);
          status.textContent = result.drafts.size === 0 ? '这几题 AI 没有起草出来' : '';
          void load();
        })();
      });
      list.append(draftButton);
    }
  };

  const submit = async (event: Event, fill: HTMLButtonElement, mine: number) => {
    // 记忆关着但有档案预填时，这一轮点头照样有效：那些题不靠记忆开关摆出来。
    if (mine !== generation || loaded?.generation !== mine || (!enable.checked && prefills.size === 0 && drafted.size === 0)) {
      status.textContent = '设置或页面已变，请重新生成候选答案';
      return;
    }
    // Everything the click confirmed is captured here, before anything is awaited: the values,
    // the chosen scopes and the load they belong to. The inputs are locked while the write is
    // pending, and only this snapshot is written and remembered; a later edit is another
    // confirmation, and a load retired meanwhile saves nothing.
    const context = loaded.context;
    const confirmed = [...rows].flatMap(([questionId, row]) => {
      const value = row.read().trim();
      const [scope, , answerClass] = scopeOptions[row.scope.selectedIndex] ?? scopeOptions[0]!;
      const question = handlers.questions.find((item) => item.questionId === questionId);
      return value && question ? [{ questionId, value, scope, answerClass, question, row }] : [];
    });
    const lock = (locked: boolean) => {
      fill.disabled = locked;
      for (const { row } of confirmed) { row.lock(locked); row.scope.disabled = locked; }
    };
    lock(true);
    const results = await handlers.answer(event, shadow, confirmed.map(({ questionId, value }) => ({ questionId, value })), context);
    // The load may be retired (disabled, dismissed, reloaded) at any await: nothing further is
    // saved once it is, though a save already sent is not undone.
    const live = () => mine === generation && enable.checked && section.isConnected;
    if (!live()) return;
    let remembered = 0;
    for (const result of results) {
      const item = confirmed.find((candidate) => `question:${candidate.questionId}` === result.key);
      if (!item) continue;
      item.row.mark.textContent = result.ok ? '✓ 已填' : `× ${result.reason}`;
      if (!result.ok || !item.scope || !item.answerClass) continue;
      if (!live()) break;
      const saved = await handlers.remember({ question: item.question, value: item.value, scope: item.scope, answerClass: item.answerClass, context });
      if (saved) remembered += 1;
      if (!live()) break;
    }
    if (!live()) return;
    status.textContent = `已回填 ${results.filter((result) => result.ok).length}/${confirmed.length}${remembered ? `，记住 ${remembered} 题` : ''}`;
    lock(false);
  };

  const applySettings = (settings: ApplicationQuestionSettingsV1 | null) => {
    enable.checked = settings?.enabled === true;
    autoReuse.checked = settings?.autoReuse === true;
    if (enable.checked || prefills.size > 0 || draftable) void load();
  };
  const persist = async () => {
    enable.disabled = autoReuse.disabled = true;
    const settings = await handlers.updateSettings({ schemaVersion: 1, enabled: enable.checked, disclosureVersion: QUESTION_DISCLOSURE_VERSION, autoReuse: autoReuse.checked });
    enable.disabled = autoReuse.disabled = false;
    if (!settings) { status.textContent = '设置没保存成功，请重试'; return; }
    if (settings.enabled || prefills.size > 0 || draftable) void load();
    else { retire(); status.textContent = ''; }
  };
  enable.addEventListener('change', () => { void persist(); });
  autoReuse.addEventListener('change', () => { void persist(); });
  void handlers.loadSettings().then(applySettings);
  return section;
}

/** One rendered question: how to read the confirmed value and lock the control while a write is pending. */
interface QuestionRow { readonly read: () => string; readonly lock: (locked: boolean) => void; readonly scope: HTMLSelectElement; readonly mark: HTMLElement }

/** The control the answer is edited in, shaped like the host's: checkboxes for a multi-choice, a select for a single choice, text otherwise. */
function renderControl(doc: Document, question: QuestionDescription, value: string): Pick<QuestionRow, 'read' | 'lock'> & { readonly control: HTMLElement } {
  if (question.controlType === 'MULTI_CHOICE') {
    const chosen = new Set(value.split('\n'));
    const boxes = question.options.map((option) => {
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.value = option.text;
      box.checked = chosen.has(option.text);
      const item = doc.createElement('label');
      item.append(box, doc.createTextNode(option.text));
      return { box, item };
    });
    const control = doc.createElement('div');
    control.className = 'choices';
    control.append(...boxes.map(({ item }) => item));
    return { control, read: () => boxes.filter(({ box }) => box.checked).map(({ box }) => box.value).join('\n'), lock: (locked) => { for (const { box } of boxes) box.disabled = locked; } };
  }
  if (question.controlType === 'SINGLE_CHOICE') {
    const select = doc.createElement('select');
    select.append(new Option('请选择', ''), ...question.options.map((option) => new Option(option.text, option.text, false, option.text === value)));
    // 选中态在挂进 select 之后再定一次：预选（档案预填 / 记忆候选）要在任何 DOM 实现下都真的选上。
    select.value = value;
    return { control: select, read: () => select.value, lock: (locked) => { select.disabled = locked; } };
  }
  const input = doc.createElement(question.controlType === 'TEXTAREA' ? 'textarea' : 'input');
  input.value = value;
  return { control: input, read: () => input.value, lock: (locked) => { input.disabled = locked; } };
}

function renderQuestion(
  doc: Document,
  question: QuestionDescription,
  candidate: ApplicationQuestionCandidateV1,
  rows: Map<string, QuestionRow>,
  scopeOptions: typeof SCOPE_OPTIONS,
  note?: string,
): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'question';
  const label = doc.createElement('span');
  label.className = 'label';
  label.textContent = question.text;
  const hint = doc.createElement('span');
  hint.className = 'detail';
  hint.textContent = note === undefined ? HINT[candidate.disposition] : `${HINT[candidate.disposition]}（${note}）`;
  const { control, read, lock } = renderControl(doc, question, candidateValue(question, candidate));
  const scope = doc.createElement('select');
  scope.append(...scopeOptions.map(([, text]) => new Option(text)));
  const mark = doc.createElement('span');
  mark.className = 'detail';
  const memory = doc.createElement('label');
  memory.append(doc.createTextNode('记住：'), scope);
  row.append(label, hint, control, memory, mark);
  rows.set(question.questionId, { read, lock, scope, mark });
  return row;
}

/** AI 草稿做成一条本地候选：REVIEW_REQUIRED 那句提示（「AI 草稿，请审阅后回填」）正是它。 */
function draftCandidate(question: QuestionDescription, text: string): ApplicationQuestionCandidateV1 {
  return Object.freeze({
    questionId: question.questionId,
    disposition: 'REVIEW_REQUIRED' as const,
    reasonCode: 'EVIDENCE_BOUND' as const,
    answer: { kind: 'TEXT' as const, text },
    confidence: 'LOW' as const,
    provenance: [],
  });
}

/** 档案预填做成一条本地候选：形状与记忆候选一样，面板照旧预选、照旧要用户点头。 */
function prefillCandidate(question: QuestionDescription, text: string): ApplicationQuestionCandidateV1 {
  const answer = question.controlType === 'SINGLE_CHOICE' || question.controlType === 'MULTI_CHOICE'
    ? { kind: 'CHOICES' as const, optionIds: question.options.filter((option) => option.text === text).map((option) => option.optionId) }
    : { kind: 'TEXT' as const, text };
  return Object.freeze({
    questionId: question.questionId,
    disposition: 'USER_CONFIRMATION_REQUIRED' as const,
    reasonCode: 'USER_CONFIRMED_VALUE' as const,
    answer,
    confidence: 'HIGH' as const,
    provenance: [],
  });
}

function candidateValue(question: QuestionDescription, candidate: ApplicationQuestionCandidateV1): string {
  if (!candidate.answer) return '';
  if (candidate.answer.kind === 'TEXT') return candidate.answer.text;
  const chosen = new Set(candidate.answer.optionIds);
  return question.options.filter((option) => chosen.has(option.optionId)).map((option) => option.text).join('\n');
}
