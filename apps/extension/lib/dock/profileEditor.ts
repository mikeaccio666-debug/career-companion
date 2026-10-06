import type { CandidateProfileSnapshotV2 } from '@edaix/contracts';
import type { ProfileDirectoryClient } from '../profileDirectoryClient';
import type { DockCopy } from './copy';
import { EASE, EASE_OUT, SPRING } from './css';
import { animate, el, trusted } from './dom';
import { icon } from './icons';
import {
  DEGREE_LABEL,
  dirtyCount as countDirty,
  draftFromSnapshot,
  patchFromDraft,
  validate,
  WORK_MODE_LABEL,
  type EduDraft,
  type ExpDraft,
  type ProfileDraft,
} from './profileModel';
import { mergeDrafts, type DraftConflict } from './profileMerge';
import type { DockEeoAnswers, DockEeoRecord, DockPortResult, DockProfileEditorPorts, DockResumeLibrary } from './profileEditorPorts';
import type { DockPortalPage } from './types';

/**
 * 「我的资料」宽版编辑器（设计 18 号画面）。
 *
 * 面板横向拉宽到 `min(980px, 视口宽 − 20px)`；左侧 212px 导航分四组（个人 / 求职 / 经历 / 申请设置），
 * 右侧 12 张卡片。会影响自动填写的字段都能直接改：短字段两列、是非题分段、多选胶囊、列表型标签输入、
 * 经历与教育是可折叠条目、代填授权是开关、默认简历是单选。改了的项亮一个橙点，底部保存栏写
 * 「N 项修改未保存」；保存时整页蒙一层、中间一个 104px 的方块转圈，成功后画圈、打勾、弹一下。
 *
 * 保存直接落到用户在 ArgoLand 的资料上（Profile V2 / 自我认同 / 代填授权 / 默认简历各走各的门），
 * 下一次自动填写就用新的资料。
 */

export interface DockProfileEditorDeps {
  readonly directory?: Pick<ProfileDirectoryClient, 'profileV2' | 'saveProfileV2'>;
  readonly ports?: DockProfileEditorPorts;
  readonly reduced: () => boolean;
  readonly toast: (text: string) => void;
  /** 放弃或保存之后离开资料页。 */
  readonly onLeave: () => void;
  /** 保存成功（调用方据此作废预取的档案）。 */
  readonly onSaved: () => void;
  readonly onOpenPortal: (page: DockPortalPage) => void;
  /** 浮层这一套语言的文案（用它的 `profile` 那一块）。 */
  readonly copy: DockCopy;
  /** 保存那一段自己抛了（不是服务端没收）：交一个稳定码与那个错（只取类名，2026-10-04）。 */
  readonly onError?: (code: 'PROFILE_SAVE_THREW', error: unknown) => void;
}

export interface DockProfileEditor {
  readonly element: HTMLElement;
  /** 进资料页：重新读一遍资料，入场动画。 */
  readonly open: () => void;
  /** 想离开：没有未保存的修改就返回 true；有就摆出「离开前要保存吗？」并返回 false。 */
  readonly requestLeave: () => boolean;
  /** Esc：先关确认框；关掉了返回 true。 */
  readonly handleEscape: () => boolean;
  /** ⌘S */
  readonly save: () => void;
  /** 面板此刻的宽度（决定导航栏显不显示）。 */
  readonly layout: (width: number) => void;
  /**
   * 换了一个人（退出登录、换了账号，2026-10-04）：上一个人的那一份连同没存的修改一起丢掉，一个字都不留给下一个人，
   * 也绝不存进他的资料；`reopen` 时（资料页开着）按新的那个人重新读。
   */
  readonly forget: (reopen: boolean) => void;
  /** 他刚回到这一页（可能刚在门户里改过资料）：资料页开着就在后台再对一次，读到新的就换上（2026-10-04）。 */
  readonly revalidate: () => void;
}

type Opt = readonly [value: string, label: string];
type FieldType = 'text' | 'area' | 'date' | 'month' | 'select' | 'seg' | 'chips' | 'choice' | 'tags' | 'toggle' | 'stepper' | 'phone' | 'money' | 'resume';

interface FieldDef {
  readonly k: string;
  readonly l: string;
  readonly t: FieldType;
  readonly o?: readonly Opt[];
  readonly span?: 2;
  readonly row?: boolean;
  readonly ph?: string;
  /** 选填：不算进完成度。 */
  readonly opt?: boolean;
  /** 步进器上的数怎么读（「14 天」）。 */
  readonly unit?: (value: number) => string;
  readonly step?: number;
  readonly when?: readonly [string, string];
  /** 条目里：这个开关开着时本栏停用（「目前在职」时的「结束」）。 */
  readonly off?: string;
  /** 条目里：这个开关开着时本栏换一个名字（「在读」时的「结束」叫「预计毕业」，照样能填）。 */
  readonly alt?: readonly [toggle: string, label: string];
}

type GroupKey = keyof DockCopy['profile']['groups'];

interface SectionDef {
  readonly g: GroupKey;
  readonly id: string;
  readonly title: string;
  readonly fields?: readonly FieldDef[];
  readonly entries?: 'exp' | 'edu';
  readonly ef?: readonly FieldDef[];
  readonly add?: string;
  readonly cap?: string;
  /** 标题下面一行点得开的链接（代填授权那一节：隐私政策里写明范围的那一节，2026-09-28）。 */
  readonly capLink?: Readonly<{ text: string; page: DockPortalPage }>;
  readonly badge?: string;
}

const US_STATES: readonly Opt[] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'],
  ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'],
  ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

const EEO_DISCLOSURE = 'self-identification-2026-09-21';

/**
 * 十二张卡片（设计 18 号画面）：看得见的字都取自 `P`（浮层这一套语言的 `profile`），存进草稿的值不跟着语言变——
 * 自我认同存的是门户那几句英文原文，办公模式与学位存的是 `profileModel` 里那几个词，其余是 yes/no 与各自的代码。
 */
function schemaOf(P: DockCopy['profile']): readonly SectionDef[] {
  const F = P.fields;
  const O = P.options;
  const E = P.eeo;
  return [
    { g: 'personal', id: 'basic', title: P.sections.basic, fields: [
      { k: 'first', l: F.first, t: 'text' }, { k: 'last', l: F.last, t: 'text' },
      { k: 'preferred', l: F.preferred, t: 'text', ph: P.optional, opt: true },
      { k: 'pronouns', l: F.pronouns, t: 'select', o: [['', O.unset], ['She/Her', 'she/her'], ['He/Him', 'he/him'], ['They/Them', 'they/them'], ['Prefer not to say', O.preferNotToSay]], opt: true },
      { k: 'email', l: F.email, t: 'text' }, { k: 'phone', l: F.phone, t: 'phone' },
    ] },
    { g: 'personal', id: 'addr', title: P.sections.addr, fields: [
      { k: 'line1', l: F.line1, t: 'text', span: 2 }, { k: 'city', l: F.city, t: 'text' },
      { k: 'region', l: F.region, t: 'select', o: [['', O.unset], ...US_STATES] },
      { k: 'postal', l: F.postal, t: 'text' },
      { k: 'country', l: F.country, t: 'select', o: [['US', O.countries.US], ['CA', O.countries.CA], ['CN', O.countries.CN], ['GB', O.countries.GB]] },
    ] },
    { g: 'personal', id: 'links', title: P.sections.links, fields: [
      { k: 'linkedin', l: 'LinkedIn', t: 'text' }, { k: 'github', l: 'GitHub', t: 'text' },
      { k: 'portfolio', l: F.portfolio, t: 'text', ph: P.optional, opt: true }, { k: 'website', l: F.website, t: 'text', ph: P.optional, opt: true },
    ] },
    { g: 'job', id: 'auth', title: P.sections.auth, fields: [
      { k: 'workAuth', l: F.workAuth, t: 'seg', o: [['yes', O.authorized], ['no', O.notAuthorized]], row: true },
      { k: 'sponsor', l: F.sponsor, t: 'seg', o: [['no', O.sponsorNo], ['yes', O.sponsorYes]], row: true },
      { k: 'over18', l: F.over18, t: 'seg', o: [['yes', O.yes], ['no', O.no]], row: true },
    ] },
    { g: 'job', id: 'prefs', title: P.sections.prefs, fields: [
      { k: 'salary', l: F.salary, t: 'money', span: 2 },
      { k: 'modes', l: F.modes, t: 'chips', o: WORK_MODES.map((mode) => [WORK_MODE_LABEL[mode], O.workModes[mode]] as const), span: 2 },
      { k: 'start', l: F.start, t: 'date' }, { k: 'notice', l: F.notice, t: 'stepper', unit: P.days, step: 7 },
      { k: 'relocate', l: F.relocate, t: 'seg', o: [['yes', O.relocateYes], ['no', O.relocateNo]], row: true },
      { k: 'cities', l: F.cities, t: 'tags', span: 2, when: ['relocate', 'yes'], ph: P.cityPlaceholder },
    ] },
    { g: 'job', id: 'qa', title: P.sections.qa, fields: [
      { k: 'referral', l: F.referral, t: 'choice', o: [['LinkedIn', 'LinkedIn'], ['Company website', O.referral.companySite], ['Referral', O.referral.referral], ['Job board', O.referral.jobBoard], ['Other', O.referral.other]], span: 2 },
      { k: 'summary', l: F.summary, t: 'area', span: 2 },
    ] },
    { g: 'history', id: 'exp', title: P.sections.exp, entries: 'exp', add: P.addExperience, ef: [
      { k: 'title', l: F.title, t: 'text' }, { k: 'company', l: F.company, t: 'text' }, { k: 'loc', l: F.loc, t: 'text' },
      { k: 'current', l: F.current, t: 'toggle' }, { k: 'from', l: F.from, t: 'month' }, { k: 'to', l: F.to, t: 'month', off: 'current' },
      { k: 'desc', l: F.desc, t: 'area', span: 2 },
    ] },
    { g: 'history', id: 'edu', title: P.sections.edu, entries: 'edu', add: P.addEducation, ef: [
      { k: 'school', l: F.school, t: 'text', span: 2 },
      { k: 'degree', l: F.degree, t: 'choice', o: degreeOptions(P), span: 2 },
      { k: 'major', l: F.major, t: 'text' }, { k: 'gpa', l: 'GPA', t: 'text', ph: P.optional },
      // 在读（2026-10-04）：开着时「结束」那一格是预计毕业时间（存进 expectedGraduationDate）。看得见、能改，保存时一并确认。
      { k: 'current', l: F.inSchool, t: 'toggle', row: true },
      { k: 'from', l: F.from, t: 'month' }, { k: 'to', l: F.to, t: 'month', alt: ['current', F.expectedGraduation] },
    ] },
    { g: 'history', id: 'skills', title: P.sections.skills, fields: [
      { k: 'skills', l: F.skills, t: 'tags', span: 2, ph: P.tagPlaceholder },
      { k: 'langs', l: F.langs, t: 'tags', span: 2, ph: P.langPlaceholder },
    ] },
    { g: 'settings', id: 'resume', title: P.sections.resume, fields: [{ k: 'resume', l: '', t: 'resume', span: 2 }] },
    // 代填授权（文案版本 application-signing-2026-09-24，与门户资料页那一格逐字相同）：逐类点名插件会以
    // 他的名义做的每一件事。文案一改就得在 argoland 升版本，旧版本的同意随即失效。
    { g: 'settings', id: 'consent', title: P.sections.consent, capLink: { text: P.consentScopeCta, page: P.consentScopePage }, fields: [
      { k: 'consent', l: P.consentLabel, t: 'toggle', row: true },
    ] },
    { g: 'settings', id: 'eeo', title: P.sections.eeo, badge: P.optional, cap: E.caption, fields: [
      { k: 'gender', l: F.gender, t: 'seg', o: [['Woman', E.woman], ['Man', E.man], [DECLINE, E.decline]], row: true },
      { k: 'hispanic', l: F.hispanic, t: 'seg', o: [['Yes', O.yes], ['No', O.no], [DECLINE, E.decline]], row: true },
      { k: 'race', l: F.race, t: 'chips', o: [
        ['Asian', E.asian], ['White', E.white], ['Black or African American', E.black], ['American Indian or Alaska Native', E.nativeAmerican],
        ['Native Hawaiian or Other Pacific Islander', E.pacificIslander], [DECLINE, E.decline],
      ], span: 2 },
      { k: 'veteran', l: F.veteran, t: 'seg', o: [['I am not a protected veteran', E.notVeteran], ['I am a protected veteran', E.veteran], [NO_ANSWER, E.decline]], row: true },
      { k: 'disability', l: F.disability, t: 'seg', o: [
        ['No, I do not have a disability and have not had one in the past', E.noDisability],
        ['Yes, I have a disability, or have had one in the past', E.disability],
        [NO_ANSWER, E.decline],
      ], row: true },
      { k: 'eeoReuse', l: F.eeoReuse, t: 'toggle', row: true },
    ] },
  ];
}
/** 自我认同里「不愿回答」的两种原文（门户那几句英文）。 */
const DECLINE = 'Decline to self-identify';
const NO_ANSWER = "I don't wish to answer";
const WORK_MODES = ['REMOTE', 'HYBRID', 'ONSITE'] as const;
const DEGREES = ['ASSOCIATE', 'BACHELOR', 'MASTER', 'PHD'] as const;
/** 学位的选项：值是草稿里存的那个词（`DEGREE_LABEL`），按钮上是这一套语言的说法。 */
const degreeOptions = (P: DockCopy['profile']): readonly Opt[] => DEGREES.map((level) => [DEGREE_LABEL[level] ?? '', P.options.degrees[level]] as const);
const GROUPS: readonly GroupKey[] = ['personal', 'job', 'history', 'settings'];
const INK = '#0A1128';
const MUTED = '#6B778C';
const FAINT = '#8A94A8';
const GREEN = '#25795A';
const WARM_INK = '#A3521B';

interface Extras {
  readonly consent: boolean | null;
  readonly gender: string;
  readonly hispanic: string;
  readonly race: readonly string[];
  readonly veteran: string;
  readonly disability: string;
  readonly eeoReuse: boolean;
  readonly resume: string;
}

type AnyDraft = ProfileDraft & Extras;

/** 一次读到的四样：资料（不可缺）、自我认同、代填授权、默认简历。 */
interface LiveRead {
  readonly profile: DockPortResult<CandidateProfileSnapshotV2>;
  readonly eeo: DockPortResult<DockEeoRecord>;
  readonly consent: DockPortResult<boolean>;
  readonly resumes: DockPortResult<DockResumeLibrary>;
}
/** 资料那一样读到了的那一次。 */
type FreshRead = LiveRead & { readonly profile: Readonly<{ ok: true; value: CandidateProfileSnapshotV2 }> };

export function createDockProfileEditor(doc: Document, deps: DockProfileEditorDeps): DockProfileEditor {
  const P = deps.copy.profile;
  const SCHEMA = schemaOf(P);
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => el(doc, tag, cls, text);
  const tb = (cls: string, onSelect: (event: MouseEvent) => void, text?: string) => trusted(doc, cls, onSelect, text);

  // ── 状态 ───────────────────────────────────────────────────────
  let status: 'loading' | 'ready' | 'unavailable' = 'loading';
  let unavailableCode = '';
  let snapshot: CandidateProfileSnapshotV2 | null = null;
  let base: AnyDraft | null = null;
  let draft: AnyDraft | null = null;
  let eeoRecord: DockEeoRecord | null = null;
  let eeoAvailable = false;
  let consentAvailable = false;
  let resumes: DockResumeLibrary | null = null;
  let errors: Record<string, string> = {};
  let saving = false;
  let justSaved = false;
  let hud: '' | 'saving' | 'done' = '';
  let confirmOpen = false;
  let active = 'basic';
  const openEntries = new Set<string>();
  let loadSerial = 0;
  let railVisible = true;
  let spyLock = 0;
  /**
   * 摆着的这一份新不新（2026-10-04，先显示旧的、后台换新）：`checking` 后台正在对；`failed` 没对上，摆的仍是 `readAt` 那一刻
   * 读到的（`staleCode` 是原因码）。
   */
  let freshness: 'fresh' | 'checking' | 'failed' = 'fresh';
  let readAt: number | null = null;
  let staleCode = '';
  /** 存的时候后台正好读到了一份（可能比刚存下的还旧）：不用它，存完再现读一次（存的那一路遇到 412 自己会重读）。 */
  let recheckAfterSave = false;
  /** 换了一次人就加一（forget）：存到一半换了人，那一轮立刻停下，上一个人的修改一个字都不再发（2026-10-04）。 */
  let generation = 0;
  /** 同一项两边都改了、还没选的那几项（2026-10-04）：选完才存；关掉不选，再按保存还会问。 */
  let conflicts: readonly DraftConflict<AnyDraft>[] = [];
  let conflictOpen = false;
  const conflictPicks = new Map<number, 'MINE' | 'THEIRS'>();
  /** 撞上冲突的那一次保存之后要做的事（离开前存的那一下：选完存成了再离开）。 */
  let afterConflicts: (() => void) | undefined;

  // ── 骨架 ───────────────────────────────────────────────────────
  const element = h('div', 'pf');
  const mainRow = h('div', 'pf-main');
  const rail = h('nav', 'pf-rail');
  rail.dataset.scroll = '1';
  const railHead = h('div', 'pf-rail-head');
  const railAvatar = h('span', 'pf-avatar');
  const railName = h('b', 'pf-rail-name');
  const railMail = h('span', 'pf-rail-mail');
  const railText = h('span', 'pf-rail-text');
  railText.append(railName, railMail);
  // 资料还没读到时头像里是一个人形图标（与页头的头像同一个），读到了换成首字母。
  railAvatar.append(icon(doc, 'person', 16, { stroke: 1.8 }));
  railHead.append(railAvatar, railText);
  const railGroups = h('div', '');
  rail.append(railHead, railGroups);
  const scroller = h('div', 'pf-scroll');
  scroller.dataset.scroll = '1';
  const sectionsWrap = h('div', 'pf-sections');
  scroller.append(sectionsWrap);
  mainRow.append(rail, scroller);

  const bar = h('div', 'pf-bar');
  const barStatus = h('span', 'pf-status');
  const barSpacer = h('span', 'pf-spacer');
  const discardBtn = tb('pf-discard', () => discard(), P.discard);
  const saveBtn = tb('pf-save', () => save());
  saveBtn.dataset.action = 'profile-save';
  bar.append(barStatus, barSpacer, discardBtn, saveBtn);

  const hudLayer = h('div', 'pf-hud');
  const hudBox = h('div', 'pf-hud-box');
  const hudSpin = h('span', 'pf-hud-spin');
  const hudDone = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  hudDone.setAttribute('width', '44');
  hudDone.setAttribute('height', '44');
  hudDone.setAttribute('viewBox', '0 0 44 44');
  const hudCircle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [k, v] of [['cx', '22'], ['cy', '22'], ['r', '19'], ['fill', 'none'], ['stroke', GREEN], ['stroke-width', '3'], ['stroke-linecap', 'round'], ['stroke-dasharray', '120'], ['stroke-dashoffset', '0'], ['transform', 'rotate(-90 22 22)']]) hudCircle.setAttribute(k as string, v as string);
  const hudTick = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [k, v] of [['d', 'M13.5 22.5l6 6 11-12'], ['fill', 'none'], ['stroke', GREEN], ['stroke-width', '3.2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['stroke-dasharray', '30'], ['stroke-dashoffset', '0']]) hudTick.setAttribute(k as string, v as string);
  hudDone.append(hudCircle, hudTick);
  const hudLabel = h('span', 'pf-hud-label');
  hudBox.append(hudSpin, hudDone, hudLabel);
  hudLayer.append(hudBox);

  const confirmLayer = h('div', 'pf-confirm');
  const confirmBox = h('div', 'pf-confirm-box');
  const confirmTitle = h('b', 'pf-confirm-title');
  const confirmRow = h('div', 'pf-confirm-row');
  const confirmDiscard = tb('pf-confirm-discard', () => { discard(); confirmOpen = false; paintConfirm(); deps.onLeave(); }, P.discard);
  const confirmSave = tb('pf-confirm-save', () => save(() => deps.onLeave()), P.save);
  confirmRow.append(confirmDiscard, confirmSave);
  confirmBox.append(confirmTitle, h('span', 'pf-confirm-sub', P.leaveSub), confirmRow);
  confirmLayer.append(confirmBox);
  confirmLayer.addEventListener('click', (event) => {
    if (!event.isTrusted || event.composedPath().includes(confirmBox)) return;
    confirmOpen = false;
    paintConfirm();
  });

  // 「这几项在别处也改过」（2026-10-04）：每一项两颗按钮（他刚改的／别处的），每一项都选了才能存。
  const conflictLayer = h('div', 'pf-confirm pf-conflict');
  conflictLayer.dataset.show = 'false';
  const conflictBox = h('div', 'pf-confirm-box pf-conflict-box');
  conflictBox.setAttribute('role', 'dialog');
  conflictBox.setAttribute('aria-label', P.conflict.title);
  const conflictRows = h('div', 'pf-conflict-rows');
  const conflictRow = h('div', 'pf-confirm-row');
  const conflictCancel = tb('pf-confirm-discard pf-conflict-cancel', () => closeConflicts(), P.conflict.cancel);
  conflictCancel.dataset.action = 'conflict-cancel';
  const conflictSave = tb('pf-confirm-save', () => resolveConflicts(), P.conflict.save);
  conflictSave.dataset.action = 'conflict-save';
  conflictRow.append(conflictCancel, conflictSave);
  conflictBox.append(h('b', 'pf-confirm-title', P.conflict.title), h('span', 'pf-confirm-sub', P.conflict.sub), conflictRows, conflictRow);
  conflictLayer.append(conflictBox);

  const message = h('div', 'pf-message');
  element.append(mainRow, bar, hudLayer, confirmLayer, conflictLayer);

  // ── 取值与改值 ──────────────────────────────────────────────────
  const get = (path: string, from: AnyDraft | null = draft): unknown => {
    if (from === null) return undefined;
    return path.split('.').reduce<unknown>((value, key) => (value === null || value === undefined ? value : (value as Record<string, unknown>)[key]), from);
  };
  const set = (path: string, value: unknown): void => {
    if (draft === null) return;
    const keys = path.split('.');
    const next = structuredCloneSafe(draft) as unknown as Record<string, unknown>;
    let node: Record<string, unknown> = next;
    for (let i = 0; i < keys.length - 1; i += 1) node = node[keys[i] as string] as Record<string, unknown>;
    node[keys[keys.length - 1] as string] = value;
    draft = next as unknown as AnyDraft;
    if (errors[path] !== undefined) { const copy = { ...errors }; delete copy[path]; errors = copy; }
    justSaved = false;
    refresh();
  };
  const isDirty = (path: string): boolean => JSON.stringify(get(path)) !== JSON.stringify(get(path, base));

  const extrasDirty = (): number => {
    if (draft === null || base === null) return 0;
    let n = 0;
    for (const key of ['consent', 'gender', 'hispanic', 'race', 'veteran', 'disability', 'eeoReuse', 'resume'] as const) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(base[key])) n += 1;
    }
    return n;
  };
  const dirtyTotal = (): number => (draft === null || base === null ? 0 : countDirty(draft, base) + extrasDirty());

  // ── 控件 ───────────────────────────────────────────────────────
  const updaters: Array<() => void> = [];
  const sectionUpdaters: Array<() => void> = [];

  const buildField = (fd: FieldDef, path: string, rowIndex: number, one: boolean, baseEntry: string): HTMLElement => {
    const row = fd.row === true;
    const wrap = h('div', 'pf-field');
    wrap.dataset.pfField = path;
    wrap.style.gridColumn = row || fd.span === 2 || one ? '1 / -1' : 'auto';
    if (row) {
      wrap.classList.add('pf-field-row');
      if (rowIndex > 0) wrap.classList.add('pf-field-divided');
    }
    const label = h('div', 'pf-label');
    const labelText = h('span', '', fd.l);
    const dot = h('span', 'pf-dot');
    label.append(labelText, dot);
    if (fd.l !== '') wrap.append(label);
    const ctrl = h('div', row ? 'pf-ctrl pf-ctrl-row' : 'pf-ctrl');
    wrap.append(ctrl);
    const err = h('div', 'pf-err');
    ctrl.append(err);
    const offNow = (): boolean => fd.off !== undefined && baseEntry !== '' && get(`${baseEntry}${fd.off}`) === true;
    /** 这一栏此刻叫什么（`alt`：开关开着时换一个名字）。 */
    const labelNow = (): string => (fd.alt !== undefined && baseEntry !== '' && get(`${baseEntry}${fd.alt[0]}`) === true ? fd.alt[1] : fd.l);
    const inputStyle = (node: HTMLElement): void => {
      node.classList.toggle('pf-bad', errors[path] !== undefined);
    };
    const common = (): void => {
      if (fd.alt !== undefined && labelText.textContent !== labelNow()) labelText.textContent = labelNow();
      dot.style.display = isDirty(path) || (fd.t === 'phone' && isDirty('phoneCc')) || (fd.t === 'money' && (isDirty('currency') || isDirty('period'))) ? 'block' : 'none';
      err.textContent = errors[path] ?? '';
      err.style.display = errors[path] === undefined ? 'none' : 'block';
    };
    const textLike = (node: HTMLInputElement | HTMLTextAreaElement, key = path): void => {
      node.addEventListener('input', () => set(key, node.value));
      updaters.push(() => {
        const want = String(get(key) ?? '');
        if (doc.activeElement !== node && shadowActive() !== node && node.value !== want) node.value = want;
        inputStyle(node);
      });
    };
    const select = (options: readonly Opt[], key: string, width?: string): HTMLSelectElement => {
      const node = h('select', 'pf-input pf-select');
      if (width !== undefined) node.style.width = width;
      const current = String(get(key) ?? '');
      const all = options.some(([value]) => value === current) || current === '' ? options : [...options, [current, current] as Opt];
      for (const [value, text] of all) {
        const option = h('option', '', text);
        option.value = value;
        node.append(option);
      }
      node.setAttribute('aria-label', fd.l);
      node.addEventListener('change', () => set(key, node.value));
      updaters.push(() => { const want = String(get(key) ?? ''); if (node.value !== want) node.value = want; inputStyle(node); });
      return node;
    };
    switch (fd.t) {
      case 'text': case 'date': case 'month': {
        const input = h('input', 'pf-input');
        input.type = fd.t === 'text' ? 'text' : fd.t;
        input.placeholder = fd.ph ?? '';
        input.setAttribute('aria-label', fd.l);
        input.dataset.pf = path;
        textLike(input);
        if (fd.t === 'month') updaters.push(() => {
          const off = offNow();
          input.disabled = off;
          input.style.opacity = off ? '.45' : '1';
          input.placeholder = off ? P.present : fd.ph ?? '';
          if (off) input.value = '';
          if (fd.alt !== undefined) input.setAttribute('aria-label', labelNow());
        });
        ctrl.prepend(input);
        break;
      }
      case 'area': {
        const area = h('textarea', 'pf-input pf-area');
        area.rows = 3;
        area.placeholder = fd.ph ?? '';
        area.setAttribute('aria-label', fd.l);
        textLike(area);
        ctrl.prepend(area);
        break;
      }
      case 'select':
        ctrl.prepend(select(fd.o ?? [], path, row ? '190px' : '100%'));
        break;
      case 'seg': {
        const options = fd.o ?? [];
        const n = options.length;
        const seg = h('div', 'pf-seg');
        seg.setAttribute('role', 'radiogroup');
        seg.setAttribute('aria-label', fd.l);
        seg.style.width = row ? `${n * (n > 2 ? 84 : 74)}px` : '100%';
        const thumb = h('span', 'pf-seg-thumb');
        thumb.style.width = `calc((100% - 4px) / ${n})`;
        seg.append(thumb);
        const buttons = options.map(([value, text]) => {
          const button = tb('pf-seg-btn', () => set(path, value), text);
          button.setAttribute('role', 'radio');
          seg.append(button);
          return { value, button };
        });
        updaters.push(() => {
          const current = String(get(path) ?? '');
          const index = options.findIndex(([value]) => value === current);
          thumb.style.transform = `translateX(${Math.max(0, index) * 100}%)`;
          thumb.style.opacity = index >= 0 ? '1' : '0';
          for (const { value, button } of buttons) {
            const on = value === current;
            button.style.color = on ? INK : MUTED;
            button.style.fontWeight = on ? '600' : '500';
            button.setAttribute('aria-checked', String(on));
          }
        });
        ctrl.prepend(seg);
        break;
      }
      case 'chips': case 'choice': {
        const wrapChips = h('div', 'pf-chips');
        const base = fd.o ?? [];
        const current = get(path);
        const extra: Opt[] = fd.t === 'choice' && typeof current === 'string' && current !== '' && !base.some(([value]) => value === current) ? [[current, current]] : [];
        const chips = [...base, ...extra].map(([value, text]) => {
          const chip = tb('pf-chip', () => {
            if (fd.t === 'choice') set(path, get(path) === value ? '' : value);
            else {
              const list = [...((get(path) as readonly string[] | undefined) ?? [])];
              const at = list.indexOf(value);
              if (at >= 0) list.splice(at, 1); else list.push(value);
              set(path, list);
            }
          });
          const check = icon(doc, 'check', 11, { stroke: 3.2 });
          chip.append(check, doc.createTextNode(text));
          wrapChips.append(chip);
          return { value, chip, check };
        });
        updaters.push(() => {
          const now = get(path);
          const list = fd.t === 'chips' ? ((now as readonly string[] | undefined) ?? []) : [String(now ?? '')];
          for (const { value, chip, check } of chips) {
            const on = list.includes(value);
            chip.dataset.on = String(on);
            check.style.display = on ? 'block' : 'none';
            chip.setAttribute('aria-pressed', String(on));
          }
        });
        ctrl.prepend(wrapChips);
        break;
      }
      case 'tags': {
        const box = h('div', 'pf-tags');
        const input = h('input', 'pf-tag-input');
        input.placeholder = fd.ph ?? '';
        input.setAttribute('aria-label', fd.l);
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          const value = input.value.trim();
          if (value === '') return;
          const list = [...((get(path) as readonly string[] | undefined) ?? [])];
          if (!list.includes(value)) set(path, [...list, value]);
          input.value = '';
        });
        let painted: readonly string[] | null = null;
        updaters.push(() => {
          const list = (get(path) as readonly string[] | undefined) ?? [];
          if (painted !== null && JSON.stringify(list) === JSON.stringify(painted)) return;
          const fresh = painted !== null;
          const before = new Set<string>(painted ?? []);
          painted = [...list];
          for (const node of Array.from(box.querySelectorAll('.pf-tag'))) node.remove();
          for (const value of list) {
            const tag = h('span', 'pf-tag', value);
            const remove = tb('pf-tag-rm', () => set(path, ((get(path) as readonly string[] | undefined) ?? []).filter((item) => item !== value)));
            remove.setAttribute('aria-label', P.removeTag);
            remove.append(icon(doc, 'x', 9, { stroke: 3.2 }));
            tag.append(remove);
            box.insertBefore(tag, input);
            if (fresh && !before.has(value) && !deps.reduced()) {
              animate(tag, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT });
            }
          }
        });
        box.append(input);
        ctrl.prepend(box);
        break;
      }
      case 'toggle': {
        const toggle = tb('pf-toggle', () => set(path, get(path) !== true));
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-label', fd.l);
        const knob = h('span', 'pf-knob');
        toggle.append(knob);
        updaters.push(() => {
          const on = get(path) === true;
          toggle.setAttribute('aria-checked', String(on));
          toggle.dataset.on = String(on);
        });
        ctrl.prepend(toggle);
        break;
      }
      case 'stepper': {
        const box = h('div', 'pf-stepper');
        const step = fd.step ?? 1;
        const bump = (delta: number) => {
          const current = typeof get(path) === 'number' ? get(path) as number : 0;
          set(path, Math.max(0, Math.min(180, current + delta)));
        };
        const dec = tb('pf-step-btn', () => bump(-step), '−');
        dec.setAttribute('aria-label', P.decrease);
        const value = h('span', 'pf-step-v');
        const inc = tb('pf-step-btn', () => bump(step), '+');
        inc.setAttribute('aria-label', P.increase);
        box.append(dec, value, inc);
        updaters.push(() => {
          const current = get(path);
          value.textContent = typeof current === 'number' ? fd.unit?.(current) ?? String(current) : P.notSet;
        });
        ctrl.prepend(box);
        break;
      }
      case 'phone': {
        const line = h('div', 'pf-line');
        const cc = select([['+1', '+1'], ['+86', '+86'], ['+44', '+44']], 'phoneCc', '74px');
        cc.setAttribute('aria-label', P.countryCode);
        const input = h('input', 'pf-input');
        input.setAttribute('aria-label', fd.l);
        input.dataset.pf = path;
        input.inputMode = 'tel';
        textLike(input);
        line.append(cc, input);
        ctrl.prepend(line);
        break;
      }
      case 'money': {
        const line = h('div', 'pf-line');
        const currency = select([['USD', 'USD'], ['CNY', 'CNY'], ['EUR', 'EUR'], ['GBP', 'GBP'], ['CAD', 'CAD']], 'currency', '82px');
        currency.setAttribute('aria-label', P.currency);
        const amount = h('input', 'pf-input pf-num');
        amount.inputMode = 'numeric';
        amount.setAttribute('aria-label', fd.l);
        amount.dataset.pf = path;
        textLike(amount);
        const period = select([['year', P.options.periods.year], ['month', P.options.periods.month], ['hour', P.options.periods.hour]], 'period', '96px');
        period.setAttribute('aria-label', P.payPeriod);
        line.append(currency, amount, period);
        ctrl.prepend(line);
        break;
      }
      case 'resume': {
        const list = h('div', 'pf-resumes');
        const manage = tb('pf-manage', () => deps.onOpenPortal('PROFILE'), P.manageResumes);
        manage.append(icon(doc, 'external', 11, { stroke: 2.2 }));
        let painted = '';
        updaters.push(() => {
          const items = resumes?.items ?? [];
          const key = JSON.stringify([items.map((item) => item.id), get('resume'), resumes?.defaultId]);
          if (key === painted) return;
          painted = key;
          list.replaceChildren();
          if (items.length === 0) {
            list.append(h('div', 'pf-note', resumes === null ? P.resumesUnavailable : P.noResumes));
          }
          for (const item of items) {
            const on = get('resume') === item.id;
            const card = tb('pf-resume', () => set('resume', item.id));
            card.dataset.on = String(on);
            const radio = h('span', 'pf-radio');
            radio.append(h('span', 'pf-radio-dot'));
            const tile = h('span', 'pf-resume-icon');
            tile.append(icon(doc, 'doc', 15, { stroke: 1.8 }));
            const text = h('span', 'pf-resume-text');
            text.append(h('b', 'pf-resume-name', item.name), h('span', 'pf-resume-meta', item.meta));
            card.append(radio, tile, text);
            if (resumes?.defaultId === item.id) card.append(h('span', 'pf-default', P.currentDefault));
            list.append(card);
          }
          list.append(manage);
        });
        ctrl.prepend(list);
        break;
      }
    }
    updaters.push(common);
    return wrap;
  };

  // ── 分组卡片 ────────────────────────────────────────────────────
  const sectionNodes = new Map<string, HTMLElement>();
  const sectionStats = new Map<string, { stat: string; color: string; dirty: boolean }>();

  const fieldsForSection = (sec: SectionDef): readonly FieldDef[] => {
    const all = sec.fields ?? [];
    if (sec.id === 'eeo' && !eeoAvailable) return [];
    if (sec.id === 'consent' && !consentAvailable) return [];
    return all;
  };

  const buildSection = (sec: SectionDef): HTMLElement => {
    const section = h('section', 'pf-sec');
    section.dataset.pfSec = sec.id;
    const head = h('div', 'pf-sec-head');
    const title = h('b', 'pf-sec-title', sec.title);
    head.append(title);
    if (sec.badge !== undefined) head.append(h('span', 'pf-badge', sec.badge));
    const stat = h('span', 'pf-sec-stat');
    head.append(stat);
    section.append(head);
    if (sec.cap !== undefined) section.append(h('div', 'pf-cap', sec.cap));
    if (sec.capLink !== undefined) {
      const target = sec.capLink.page;
      const link = tb('pf-manage pf-cap-link', () => deps.onOpenPortal(target), sec.capLink.text);
      link.dataset.portal = target;
      link.append(icon(doc, 'external', 11, { stroke: 2.2 }));
      section.append(link);
    }
    const one = !railVisible;
    if (sec.entries !== undefined) {
      const kind = sec.entries;
      const list = (get(kind) as readonly (ExpDraft | EduDraft)[] | undefined) ?? [];
      list.forEach((entry, index) => {
        const id = `${kind}.${index}`;
        const wrap = h('div', 'pf-entry');
        if (index > 0) wrap.classList.add('pf-entry-divided');
        const headBtn = tb('pf-entry-head', () => {
          if (openEntries.has(id)) openEntries.delete(id); else openEntries.add(id);
          refresh();
        });
        headBtn.dataset.act = 'pf-entry';
        const initial = h('span', 'pf-entry-initial');
        const text = h('span', 'pf-entry-text');
        const etitle = h('b', 'pf-entry-title');
        const esub = h('span', 'pf-entry-sub');
        text.append(etitle, esub);
        const edot = h('span', 'pf-dot');
        const chev = h('span', 'pf-entry-chev');
        chev.append(icon(doc, 'chevronDown', 14));
        headBtn.append(initial, text, edot, chev);
        const fold = h('div', 'pf-entry-fold');
        const clip = h('div', 'pf-clip');
        const grid = h('div', 'pf-grid');
        let rowIndex = 0;
        for (const fd of sec.ef ?? []) grid.append(buildField(fd, `${id}.${fd.k}`, fd.row === true ? rowIndex++ : 0, one, `${id}.`));
        const remove = tb('pf-entry-rm', () => {
          const next = ((get(kind) as readonly unknown[] | undefined) ?? []).filter((_, at) => at !== index);
          openEntries.clear();
          set(kind, next);
          rebuildSection(sec.id);
        }, P.removeEntry);
        clip.append(grid, remove);
        fold.append(clip);
        wrap.append(headBtn, fold);
        section.append(wrap);
        sectionUpdaters.push(() => {
          const current = (get(id) as (ExpDraft & EduDraft) | undefined);
          if (current === undefined) return;
          const exp = kind === 'exp';
          // 在读的教育写预计毕业（「2023.09 — 预计 2027.05」）；在职的经历照旧写「至今」。
          const end = current.current
            ? (!exp && current.to !== '' ? `${P.expected} ${current.to.replace('-', '.')}` : P.present)
            : current.to.replace('-', '.');
          const range = `${current.from !== '' ? current.from.replace('-', '.') : ''}${current.from !== '' && (current.to !== '' || current.current) ? ' — ' : ''}${end}`;
          etitle.textContent = exp ? (current.title || P.newExperience) : (current.school || P.newEducation);
          // 学位在草稿里存的是 `DEGREE_LABEL` 那几个词：副标题上写这一套语言的说法。
          const degree = degreeOptions(P).find(([value]) => value === current.degree)?.[1] ?? current.degree;
          const parts = (exp ? [current.company, range] : [degree, current.major, range]).filter((part) => typeof part === 'string' && part.trim() !== '');
          esub.textContent = parts.length > 0 ? parts.join(' · ') : P.openToFill;
          initial.textContent = ((exp ? current.company : current.school) ?? '').trim()[0] ?? '+';
          const open = openEntries.has(id);
          fold.dataset.open = String(open);
          chev.style.transform = open ? 'rotate(180deg)' : 'none';
          const baseList = (get(kind, base) as readonly unknown[] | undefined) ?? [];
          edot.style.display = index >= baseList.length || JSON.stringify(current) !== JSON.stringify(baseList[index]) ? 'block' : 'none';
        });
      });
      const add = tb('pf-add', () => {
        const blank = kind === 'exp'
          ? { id: null, title: '', company: '', loc: '', current: false, from: '', to: '', desc: '' }
          : { id: null, school: '', degree: '', major: '', gpa: '', current: false, from: '', to: '' };
        const list2 = [...((get(kind) as readonly unknown[] | undefined) ?? []), blank];
        openEntries.add(`${kind}.${list2.length - 1}`);
        set(kind, list2);
        rebuildSection(sec.id);
      }, `+ ${sec.add ?? ''}`);
      add.dataset.act = 'pf-entry-add';
      section.append(add);
    } else {
      const grid = h('div', 'pf-grid');
      let rowIndex = 0;
      const fields = fieldsForSection(sec);
      if (fields.length === 0 && (sec.id === 'eeo' || sec.id === 'consent')) {
        // 先摆出来的是上一次的那一份、这一节那时没读到（2026-10-04）：后台还在读，就说正在读，不说读不到。
        section.append(h('div', 'pf-note', freshness === 'checking' ? P.sectionLoading : P.sectionUnavailable));
      }
      for (const fd of fields) {
        const node = buildField(fd, fd.k, fd.row === true ? rowIndex++ : 0, one, '');
        if (fd.when !== undefined) {
          const [key, value] = fd.when;
          updaters.push(() => { node.style.display = get(key) === value ? '' : 'none'; });
        }
        grid.append(node);
      }
      section.append(grid);
    }
    sectionUpdaters.push(() => {
      const info = statFor(sec);
      sectionStats.set(sec.id, info);
      stat.textContent = info.stat;
      stat.style.color = info.color;
    });
    return section;
  };

  const statFor = (sec: SectionDef): { stat: string; color: string; dirty: boolean } => {
    if (sec.entries !== undefined) {
      const list = (get(sec.entries) as readonly unknown[] | undefined) ?? [];
      const baseList = (get(sec.entries, base) as readonly unknown[] | undefined) ?? [];
      return { stat: P.entryCount(list.length), color: FAINT, dirty: JSON.stringify(list) !== JSON.stringify(baseList) };
    }
    const fields = fieldsForSection(sec).filter((fd) => fd.when === undefined || get(fd.when[0]) === fd.when[1]);
    const dirty = fields.some((fd) => isDirty(fd.k) || (fd.t === 'phone' && isDirty('phoneCc')) || (fd.t === 'money' && (isDirty('currency') || isDirty('period'))));
    if (sec.id === 'consent') return { stat: get('consent') === true ? P.on : P.off, color: FAINT, dirty };
    if (sec.id === 'resume') return { stat: '', color: FAINT, dirty };
    const counted = fields.filter((fd) => fd.opt !== true && fd.ph === undefined && fd.t !== 'toggle' && fd.t !== 'stepper');
    const filled = counted.filter((fd) => {
      const value = get(fd.k);
      return Array.isArray(value) ? value.length > 0 : value !== '' && value !== null && value !== undefined;
    }).length;
    if (counted.length === 0) return { stat: '', color: FAINT, dirty };
    return filled === counted.length ? { stat: '✓', color: GREEN, dirty } : { stat: `${filled} / ${counted.length}`, color: WARM_INK, dirty };
  };

  // ── 左侧导航 ────────────────────────────────────────────────────
  // 导航只建一次（2026-09-24）：它只取决于 SCHEMA，不取决于资料。从前每读到一次资料就整列拆掉重建、再重放一遍
  // 入场动画——左边本来就在屏幕上，右边的资料一到它就闪一下。现在资料到了只改值真的变了的那几处（统计、选中项）。
  const navItems = new Map<string, { button: HTMLButtonElement; dot: HTMLElement; stat: HTMLElement }>();
  const buildRail = (): void => {
    for (const group of GROUPS) {
      railGroups.append(h('div', 'pf-group', P.groups[group]));
      for (const sec of SCHEMA.filter((item) => item.g === group)) {
        const button = tb('pf-nav', () => nav(sec.id));
        button.dataset.navItem = '1';
        button.dataset.act = 'pf-nav';
        const title = h('span', 'pf-nav-title', sec.title);
        const dot = h('span', 'pf-dot');
        const stat = h('span', 'pf-nav-stat');
        button.append(title, dot, stat);
        railGroups.append(button);
        navItems.set(sec.id, { button, dot, stat });
      }
    }
  };
  /**
   * 只在值变了时才写：同样的值再写一遍，读屏与排版都会当成一次改动。上一次写下的值记在这里比，不回读样式
   * （浏览器回读的颜色是换算过的 rgb()，与写进去的写法对不上）。
   */
  const written = new WeakMap<HTMLElement, Map<string, string>>();
  const put = (node: HTMLElement, key: 'text' | 'color' | 'display' | 'on', value: string): void => {
    let record = written.get(node);
    if (record === undefined) { record = new Map(); written.set(node, record); }
    if (record.get(key) === value) return;
    record.set(key, value);
    if (key === 'text') node.textContent = value;
    else if (key === 'on') node.dataset.on = value;
    else node.style[key] = value;
  };
  const setText = (node: HTMLElement, value: string): void => put(node, 'text', value);
  const paintRail = (): void => {
    for (const [id, item] of navItems) {
      const info = sectionStats.get(id);
      put(item.button, 'on', String(active === id));
      put(item.stat, 'text', info?.stat ?? '');
      put(item.stat, 'color', info?.color ?? FAINT);
      put(item.dot, 'display', info?.dirty === true ? 'block' : 'none');
    }
    // 资料还没读到（第一次打开）就先空着；读到了只改变了的那一处。
    if (base === null) return;
    const name = `${String(get('first', base) ?? '')} ${String(get('last', base) ?? '')}`.trim();
    setText(railName, name);
    setText(railMail, String(get('email', base) ?? ''));
    const who = initials(name);
    if (who !== '') setText(railAvatar, who);
  };

  const nav = (id: string): void => {
    active = id;
    const node = sectionNodes.get(id);
    paintRail();
    if (node === undefined) return;
    spyLock = Date.now();
    scroller.scrollTo?.({ top: Math.max(0, node.offsetTop - 6), behavior: deps.reduced() ? 'auto' : 'smooth' });
  };
  scroller.addEventListener('scroll', () => {
    if (Date.now() - spyLock < 750) return;
    let current = SCHEMA[0]?.id ?? 'basic';
    for (const sec of SCHEMA) {
      const node = sectionNodes.get(sec.id);
      if (node !== undefined && node.offsetTop - scroller.scrollTop <= 70) current = sec.id;
    }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = SCHEMA[SCHEMA.length - 1]?.id ?? current;
    if (current !== active) { active = current; paintRail(); }
  });
  buildRail();

  // ── 保存栏、蒙层、确认框 ─────────────────────────────────────────
  const paintBar = (): void => {
    const n = dirtyTotal();
    const can = n > 0 && !saving;
    barStatus.replaceChildren();
    // 先显示旧的、后台换新（2026-10-04）：没有要存的修改时，底栏说这一份新不新——正在更新，或者没能更新、是多久以前读到的。
    const checking = !saving && n === 0 && freshness === 'checking';
    const stale = !saving && n === 0 && freshness === 'failed';
    if (saving || checking) barStatus.append(h('span', 'pf-status-spin'));
    else if (can) barStatus.append(h('span', 'pf-status-dot'));
    else if (justSaved && !stale) {
      const ok = h('span', 'pf-status-ok');
      ok.append(icon(doc, 'check', 9, { stroke: 3.6 }));
      barStatus.append(ok);
    }
    const minutes = readAt === null ? 0 : Math.max(0, Math.floor((Date.now() - readAt) / 60_000));
    barStatus.append(doc.createTextNode(saving ? P.statusSaving : n > 0 ? P.statusDirty(n) : checking ? P.statusChecking
      : stale ? P.statusStale(minutes) : justSaved ? P.statusSaved : P.statusClean));
    if (stale) {
      const again = tb('pf-manage pf-recheck', () => { void load(); }, P.retry);
      again.dataset.action = 'profile-recheck';
      barStatus.append(again);
    }
    barStatus.style.color = can || stale ? WARM_INK : justSaved && n === 0 ? GREEN : MUTED;
    discardBtn.style.display = n > 0 && !saving ? 'block' : 'none';
    saveBtn.disabled = !can;
    saveBtn.dataset.can = String(can);
    saveBtn.textContent = saving ? P.saving : P.save;
  };
  const paintHud = (): void => {
    hudLayer.dataset.show = String(hud !== '');
    hudBox.style.transform = hud !== '' ? 'scale(1)' : 'scale(.9)';
    hudSpin.style.display = hud === 'saving' ? 'block' : 'none';
    hudDone.style.display = hud === 'done' ? 'block' : 'none';
    hudLabel.textContent = hud === 'done' ? P.hudSaved : P.hudSaving;
  };
  const paintConfirm = (): void => {
    confirmLayer.dataset.show = String(confirmOpen);
    confirmTitle.textContent = P.leaveTitle(dirtyTotal());
  };

  const refresh = (): void => {
    for (const update of updaters) update();
    for (const update of sectionUpdaters) update();
    paintRail();
    paintBar();
  };

  const rebuildSection = (id: string): void => {
    const sec = SCHEMA.find((item) => item.id === id);
    const old = sectionNodes.get(id);
    if (sec === undefined || old === undefined) return;
    // 这一节的更新器随节点一起换掉：先整体重建一遍更新器表。
    buildAll();
  };

  const buildAll = (): void => {
    updaters.length = 0;
    sectionUpdaters.length = 0;
    sectionNodes.clear();
    const keepScroll = scroller.scrollTop;
    sectionsWrap.replaceChildren();
    if (status !== 'ready') {
      // 右边那一栏本身里、上下左右居中（2026-09-24：从前挤在卡片列表的左上角）。
      if (message.parentElement !== scroller) scroller.append(message);
      message.replaceChildren();
      if (status === 'loading') {
        message.append(h('span', 'pf-status-spin'), doc.createTextNode(` ${P.loading}`));
      } else {
        message.append(doc.createTextNode(unavailableCode === 'LOGIN_REQUIRED' ? P.loginExpired
          : unavailableCode === 'TIMEOUT' ? P.slow
          : unavailableCode === 'BUSY' ? P.busy
          : P.unavailable));
        // 读不到：当场再试一次（2026-10-04；从前要先返回再进来）。登录过期再试也没用，不摆。
        if (unavailableCode !== 'LOGIN_REQUIRED') {
          const again = tb('pf-manage', () => { void load(); }, P.retry);
          again.dataset.action = 'profile-recheck';
          message.append(again);
        }
        const link = tb('pf-manage', () => deps.onOpenPortal('PROFILE'), P.editInPortal);
        link.append(icon(doc, 'external', 11, { stroke: 2.2 }));
        message.append(link);
        // 同一句「稍后再试」盖着七八种原因（这一页没登记、后台没答、服务器答不上来、档案形状对不上……），
        // 下面带一行原因代号，报问题时一眼就知道是哪一种（2026-09-27）。只认稳定码的形状；登录过期不挂。
        if (unavailableCode !== 'LOGIN_REQUIRED' && /^[A-Z0-9_]{3,64}$/u.test(unavailableCode)) {
          const code = h('span', 'pf-code');
          code.textContent = P.unavailableCode(unavailableCode);
          message.append(code);
        }
      }
      bar.style.display = 'none';
      return;
    }
    message.remove();
    bar.style.display = 'flex';
    for (const sec of SCHEMA) {
      const node = buildSection(sec);
      sectionNodes.set(sec.id, node);
      sectionsWrap.append(node);
    }
    refresh();
    scroller.scrollTop = keepScroll;
  };

  // ── 读 ─────────────────────────────────────────────────────────
  const unavailable = (code: string): DockPortResult<never> => ({ ok: false, code });
  /** 四样一起现读（资料不可缺；另三样各自可缺）。 */
  const readLive = async (): Promise<LiveRead> => {
    const [profile, eeo, consent, resumesRead] = await Promise.all([
      deps.directory?.profileV2().catch(() => unavailable('UNAVAILABLE')) ?? Promise.resolve(unavailable('UNAVAILABLE')),
      deps.ports?.eeo?.load().catch(() => unavailable('UNAVAILABLE')) ?? Promise.resolve(unavailable('UNAVAILABLE')),
      deps.ports?.signing?.load().catch(() => unavailable('UNAVAILABLE')) ?? Promise.resolve(unavailable('UNAVAILABLE')),
      deps.ports?.resumes?.load().catch(() => unavailable('UNAVAILABLE')) ?? Promise.resolve(unavailable('UNAVAILABLE')),
    ]);
    return { profile, eeo, consent, resumes: resumesRead };
  };
  /** 一份读到的东西摆成草稿的样子（编辑器管的全部几项）。 */
  const draftOf = (profile: CandidateProfileSnapshotV2, read: LiveRead): AnyDraft => {
    const answers: DockEeoAnswers | null = read.eeo.ok ? read.eeo.value.answers : null;
    return {
      ...draftFromSnapshot(profile, P.proficiency),
      consent: read.consent.ok ? read.consent.value : null,
      gender: answers?.genderIdentity ?? '',
      hispanic: answers?.hispanicLatino ?? '',
      race: answers?.raceEthnicity ?? [],
      veteran: answers?.veteranStatus ?? '',
      disability: answers?.disabilityStatus ?? '',
      eeoReuse: answers?.reuseEnabled ?? false,
      resume: read.resumes.ok ? read.resumes.value.defaultId ?? '' : '',
    };
  };
  /** 记下这一份的四样（资料、自我认同、代填授权、默认简历），交回它摆成的草稿。 */
  const holdRead = (profile: CandidateProfileSnapshotV2, read: LiveRead): AnyDraft => {
    snapshot = profile;
    eeoAvailable = read.eeo.ok;
    eeoRecord = read.eeo.ok ? read.eeo.value : null;
    consentAvailable = read.consent.ok;
    resumes = read.resumes.ok ? read.resumes.value : null;
    return draftOf(profile, read);
  };
  /** 资料页的骨架取决于哪几样（几节在不在、几段经历教育）：变了才整页重画，没变只改值（他正在打的那一格不动）。 */
  const shape = (): string => JSON.stringify([
    eeoAvailable, consentAvailable, draft?.exp.length, draft?.edu.length,
    // 没读到的那一节写的是「正在读取…」还是「暂时读不到」，跟着新不新走。
    eeoAvailable && consentAvailable ? '' : freshness,
  ]);
  /**
   * 后台读到了新的一份：他没改过就直接换上；改过就三方合并——他改的放到新的一份上，同一项两边都改了的记下来，存的时候请他选。
   */
  const swapIn = (read: FreshRead): void => {
    const before = shape();
    const theirs = holdRead(read.profile.value, read);
    if (base === null || draft === null || dirtyTotal() === 0) {
      base = theirs;
      draft = structuredCloneSafe(theirs);
      conflicts = [];
    } else {
      rebaseOnto(theirs);
    }
    readAt = Date.now();
    freshness = 'fresh';
    staleCode = '';
    if (shape() !== before) buildAll(); else refresh();
  };
  /** 把他手上的修改放到服务器上此刻那一份上（三方合并）；交回同一项两边都改了的那几项。 */
  const rebaseOnto = (theirs: AnyDraft): readonly DraftConflict<AnyDraft>[] => {
    if (base === null || draft === null) return [];
    const merged = mergeDrafts(base, draft, theirs);
    base = theirs;
    draft = merged.merged;
    conflicts = merged.conflicts;
    return conflicts;
  };

  /**
   * 打开资料页（2026-10-04 起先显示旧的、后台换新）：这一页里读到过就当场摆出那一份；没有就看插件 worker 里存着的上一次
   * （`ports.cached`，只在这次浏览器会话、只给这个账号）；都没有才转圈。同时在后台现读，读到了换上（他改过就合上去），
   * 读不到就照旧摆着、底栏照实说。
   */
  const load = async (): Promise<void> => {
    const serial = ++loadSerial;
    errors = {};
    justSaved = false;
    confirmOpen = false;
    paintConfirm();
    if (deps.directory === undefined) { status = 'unavailable'; unavailableCode = ''; buildAll(); return; }
    // 现读马上出发，与读缓存同时；缓存是本机的一次消息往返，几乎总是先到。
    const reading = readLive();
    if (status === 'ready' && base !== null) {
      freshness = 'checking';
      // 摆着的就是上一次的那一份：按这一次打开的样子重画一遍值（条目收起、错误清掉），底栏说正在更新。
      refresh();
    } else {
      status = 'loading';
      freshness = 'fresh';
      buildAll();
      const cached = deps.ports?.cached === undefined ? null : await deps.ports.cached().catch(() => null);
      if (serial !== loadSerial) return;
      if (cached !== null) {
        const shown = holdRead(cached.profile, { profile: { ok: true, value: cached.profile }, eeo: cached.eeo, consent: cached.consent, resumes: cached.resumes });
        base = shown;
        draft = structuredCloneSafe(shown);
        conflicts = [];
        readAt = cached.at;
        status = 'ready';
        freshness = 'checking';
        buildAll();
        playEntrance();
      }
    }
    const read = await reading;
    if (serial !== loadSerial) return;
    if (!read.profile.ok) {
      if (status === 'ready') {
        const before = shape();
        freshness = 'failed';
        staleCode = read.profile.code;
        if (shape() !== before) buildAll(); else paintBar();
        return;
      }
      status = 'unavailable';
      unavailableCode = read.profile.code;
      buildAll();
      return;
    }
    const fresh = read as FreshRead;
    if (status !== 'ready') {
      const shown = holdRead(fresh.profile.value, fresh);
      base = shown;
      draft = structuredCloneSafe(shown);
      conflicts = [];
      readAt = Date.now();
      status = 'ready';
      freshness = 'fresh';
      buildAll();
      playEntrance();
      return;
    }
    // 正在存：这一份可能比刚存下的还旧，不用它；存完再现读一次（存的那一路撞上 412 会自己重读）。
    if (saving) { recheckAfterSave = true; return; }
    swapIn(fresh);
  };

  /**
   * 资料到了：右边的卡片从上到下一张接一张出来（2026-09-24 负责人：透明度 0→1、上移 6px，每张 220ms、间隔 50ms、
   * 浮层的 EASE）。左边的导航不动——它一直在屏幕上。系统要求减少动态时不错开，直接出来。
   */
  const playEntrance = (): void => {
    if (deps.reduced()) return;
    Array.from(sectionNodes.values()).forEach((node, index) => {
      animate(node, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], {
        duration: 220, easing: EASE, delay: index * 50, fill: 'backwards',
      });
    });
  };

  // ── 存 ─────────────────────────────────────────────────────────
  const discard = (): void => {
    if (base === null) return;
    draft = structuredCloneSafe(base);
    conflicts = [];
    errors = {};
    justSaved = false;
    openEntries.clear();
    buildAll();
  };

  const save = (then?: () => void): void => {
    if (saving || draft === null || base === null || snapshot === null) return;
    // 同一项两边都改了、还没选：先请他选（关掉不选，再按保存还会问——不悄悄盖掉别处的）。
    if (conflicts.length > 0) { openConflicts(then); return; }
    if (dirtyTotal() === 0) { if (then !== undefined) then(); return; }
    // 只拦这一次改到的那几项：没碰过的栏哪怕原本就空着，也不该挡住别的修改（比如只换默认简历）。
    const found = Object.fromEntries(Object.entries(validate(draft, P.errors)).filter(([path]) => {
      if (path === 'phone') return isDirty('phone') || isDirty('phoneCc');
      const entry = /^(exp|edu)\.(\d+)\./u.exec(path);
      if (entry !== null) return isDirty(`${entry[1]}.${entry[2]}`);
      return isDirty(path);
    }));
    if (Object.keys(found).length > 0) {
      errors = { ...found };
      confirmOpen = false;
      paintConfirm();
      refresh();
      const first = Object.keys(found)[0] ?? '';
      const sec = SCHEMA.find((item) => (item.fields ?? []).some((fd) => fd.k === first) || (item.entries !== undefined && first.startsWith(`${item.entries}.`)));
      if (sec?.entries !== undefined) {
        const [kind, index] = first.split('.');
        openEntries.add(`${kind}.${index}`);
        refresh();
      }
      if (sec !== undefined) nav(sec.id);
      deps.toast(P.needsFixing(Object.keys(found).length));
      return;
    }
    saving = true;
    confirmOpen = false;
    paintConfirm();
    hud = 'saving';
    paintHud();
    paintBar();
    // 存的那一路抛了也要收住（2026-10-03 体检 3a-4：从前 saving 一直是 true，保存键与离开都卡死）：照「没存上」收住，
    // 并记一个码（2026-10-04 体检 11-2，PROFILE_SAVE_THREW）。
    void persist().catch((error: unknown): SaveOutcome => {
      try {
        deps.onError?.('PROFILE_SAVE_THREW', error);
      } catch {
        // 记不下码也照样收住。
      }
      return { kind: 'FAILED', code: 'UNAVAILABLE' };
    }).then((outcome) => finishSave(outcome, then));
  };

  const finishSave = (outcome: SaveOutcome, then?: () => void): void => {
    saving = false;
    const recheck = recheckAfterSave;
    recheckAfterSave = false;
    if (outcome.kind !== 'SAVED') {
      hud = '';
      paintHud();
      refresh();
      if (outcome.kind === 'CONFLICTS') { openConflicts(then); return; }
      // 存的时候后台在读：那一份不用，这会儿再现读一次（他改的照旧合上去）。
      if (recheck) void load();
      deps.toast(outcome.code === 'SESSION_CHANGED' ? P.saveSessionChanged
        : outcome.code === 'STALE_UNREAD' ? P.saveStaleUnread
        : outcome.code === 'STALE' ? P.saveStale
        : outcome.code === 'LOGIN_REQUIRED' ? P.saveLogin
        : outcome.code === 'INVALID' ? P.saveInvalid
        : outcome.code === 'TIMEOUT' ? P.saveTimeout
        : outcome.code === 'BUSY' ? P.saveBusy
        : P.saveFailed);
      return;
    }
    justSaved = true;
    readAt = Date.now();
    freshness = 'fresh';
    staleCode = '';
    hud = 'done';
    paintHud();
    buildAll();
    deps.onSaved();
    if (outcome.merged) deps.toast(P.saveMerged);
    // 存的时候后台在读：没存的那几样（自我认同、默认简历……）可能还是先摆出来的旧的，再现读一次。
    if (recheck) void load();
    if (!deps.reduced()) {
      animate(hudCircle, [{ strokeDashoffset: 120 }, { strokeDashoffset: 0 }], { duration: 440, easing: EASE_OUT, fill: 'backwards' });
      animate(hudTick, [{ strokeDashoffset: 30 }, { strokeDashoffset: 0 }], { duration: 300, easing: EASE_OUT, delay: 320, fill: 'backwards' });
      animate(hudBox, [{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 540, delay: 300, easing: SPRING });
    }
    setTimeout(() => {
      hud = '';
      paintHud();
      if (then !== undefined) setTimeout(then, deps.reduced() ? 0 : 260);
    }, deps.reduced() ? 60 : 1300);
  };

  type SaveOutcome =
    | Readonly<{ kind: 'SAVED'; merged: boolean }>
    | Readonly<{ kind: 'CONFLICTS' }>
    /** `STALE`：别处一直在改，合了几次还是撞上；`STALE_UNREAD`：别处改过、重读读不到。别的是传输层的码。 */
    | Readonly<{ kind: 'FAILED'; code: string }>;
  /** 一次存到哪一步：存完了，撞上了别处刚存过的哪一样（412），或者存不了（码）。 */
  type StepOutcome = Readonly<{ kind: 'DONE' }> | Readonly<{ kind: 'STALE'; section: 'V2' | 'EEO' | 'RESUME' }> | Readonly<{ kind: 'FAILED'; code: string }>;
  /** 撞上别处刚存过最多合几次：每次都重读一份、合上去再存。 */
  const MAX_REBASES = 3;

  /**
   * 存（2026-10-04 起撞上 412 不丢他的修改）：资料、自我认同、代填授权、默认简历四样依次存；哪一样撞上「别处刚存过」，就只重读
   * 那一样、把他改的逐项放上去（三方合并）再存——同一项两边都改了的停下来请他选。存成了的那几样立刻算存上（再撞上也不重发）。
   */
  const persist = async (): Promise<SaveOutcome> => {
    const started = generation;
    let merged = false;
    for (let attempt = 0; attempt <= MAX_REBASES; attempt += 1) {
      const step = await persistOnce(started);
      if (step.kind === 'FAILED' && step.code === 'SESSION_CHANGED') return { kind: 'FAILED', code: 'SESSION_CHANGED' };
      if (step.kind === 'DONE') {
        errors = {};
        return { kind: 'SAVED', merged };
      }
      if (step.kind === 'FAILED') return { kind: 'FAILED', code: step.code };
      if (attempt === MAX_REBASES) break;
      const theirs = await reread(step.section, started);
      if (generation !== started) return { kind: 'FAILED', code: 'SESSION_CHANGED' };
      if (theirs === null) return { kind: 'FAILED', code: 'STALE_UNREAD' };
      merged = true;
      if (rebaseOnto(theirs).length > 0) return { kind: 'CONFLICTS' };
    }
    return { kind: 'FAILED', code: 'STALE' };
  };

  /** 撞上 412 的那一样现读一次，交回「服务器上此刻的那一份」摆成的整份草稿（别的几样照旧是 base 里的）。 */
  const reread = async (section: 'V2' | 'EEO' | 'RESUME', started: number): Promise<AnyDraft | null> => {
    if (base === null) return null;
    if (section === 'V2') {
      const latest = await (deps.directory?.profileV2() ?? Promise.resolve(unavailable('UNAVAILABLE'))).catch(() => unavailable('UNAVAILABLE'));
      if (generation !== started || !latest.ok) return null;
      snapshot = latest.value;
      return { ...base, ...draftFromSnapshot(latest.value, P.proficiency) };
    }
    if (section === 'EEO') {
      const latest = await (deps.ports?.eeo?.load() ?? Promise.resolve(unavailable('UNAVAILABLE'))).catch(() => unavailable('UNAVAILABLE'));
      if (generation !== started || !latest.ok) return null;
      eeoRecord = latest.value;
      const a = latest.value.answers;
      return { ...base, gender: a.genderIdentity, hispanic: a.hispanicLatino, race: a.raceEthnicity, veteran: a.veteranStatus, disability: a.disabilityStatus, eeoReuse: a.reuseEnabled };
    }
    const latest = await (deps.ports?.resumes?.load() ?? Promise.resolve(unavailable('UNAVAILABLE'))).catch(() => unavailable('UNAVAILABLE'));
    if (generation !== started || !latest.ok) return null;
    resumes = latest.value;
    return { ...base, resume: latest.value.defaultId ?? '' };
  };

  /** 依次存一遍；每存成一样，那一样就同时算进 base 与 draft（服务器回的就是存下的样子）。 */
  const persistOnce = async (started: number): Promise<StepOutcome> => {
    const failed = (code: string): StepOutcome => ({ kind: 'FAILED', code });
    /** 每一次等回来先看一眼：换了人就一样都不碰（forget 已经把这一页的状态换成下一个人的了）。 */
    const changed = (): boolean => generation !== started;
    if (changed()) return failed('SESSION_CHANGED');
    if (draft === null || base === null || snapshot === null) return failed('UNAVAILABLE');
    const patch = patchFromDraft(draft, base, snapshot);
    if (patch !== null && deps.directory !== undefined) {
      const result = await deps.directory.saveProfileV2(patch).catch(() => unavailable('UNAVAILABLE'));
      if (changed()) return failed('SESSION_CHANGED');
      if (!result.ok) return result.code === 'STALE' ? { kind: 'STALE', section: 'V2' } : failed(result.code);
      snapshot = result.value;
      const saved = draftFromSnapshot(result.value, P.proficiency);
      base = { ...base, ...saved };
      draft = { ...draft, ...saved };
    }
    const eeoKeys = ['gender', 'hispanic', 'race', 'veteran', 'disability', 'eeoReuse'] as const;
    const current = draft;
    if (eeoKeys.some((key) => JSON.stringify(current[key]) !== JSON.stringify(base?.[key])) && deps.ports?.eeo !== undefined && eeoRecord !== null) {
      const result = await deps.ports.eeo.save({
        genderIdentity: current.gender,
        hispanicLatino: current.hispanic,
        raceEthnicity: current.race,
        veteranStatus: current.veteran,
        disabilityStatus: current.disability,
        reuseEnabled: current.eeoReuse,
      }, eeoRecord.revision).catch(() => unavailable('UNAVAILABLE'));
      if (changed()) return failed('SESSION_CHANGED');
      if (!result.ok) return result.code === 'STALE' ? { kind: 'STALE', section: 'EEO' } : failed(result.code);
      eeoRecord = result.value;
      const a = result.value.answers;
      const saved = { gender: a.genderIdentity, hispanic: a.hispanicLatino, race: a.raceEthnicity, veteran: a.veteranStatus, disability: a.disabilityStatus, eeoReuse: a.reuseEnabled };
      base = { ...base, ...saved };
      draft = { ...draft, ...saved };
    }
    if (draft.consent !== base.consent && draft.consent !== null && deps.ports?.signing !== undefined) {
      const result = await deps.ports.signing.set(draft.consent).catch(() => unavailable('UNAVAILABLE'));
      if (changed()) return failed('SESSION_CHANGED');
      if (!result.ok) return failed(result.code);
      base = { ...base, consent: result.value };
      draft = { ...draft, consent: result.value };
    }
    if (draft.resume !== base.resume && draft.resume !== '' && deps.ports?.resumes !== undefined) {
      const result = await deps.ports.resumes.setDefault(draft.resume).catch(() => unavailable('UNAVAILABLE'));
      if (changed()) return failed('SESSION_CHANGED');
      if (!result.ok) return result.code === 'STALE' ? { kind: 'STALE', section: 'RESUME' } : failed(result.code);
      if (resumes !== null) resumes = { ...resumes, defaultId: result.value };
      base = { ...base, resume: result.value };
      draft = { ...draft, resume: result.value };
    }
    return { kind: 'DONE' };
  };

  // ── 「这几项在别处也改过」 ─────────────────────────────────────────
  const openConflicts = (then?: () => void): void => {
    afterConflicts = then;
    conflictPicks.clear();
    conflictOpen = true;
    confirmOpen = false;
    paintConfirm();
    paintConflicts();
    if (!deps.reduced()) animate(conflictBox, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT });
  };
  const closeConflicts = (): void => {
    conflictOpen = false;
    afterConflicts = undefined;
    paintConflicts();
  };
  /** 每一项都选了：选「别处的」那几项换成别处的，其余留他的，然后存。 */
  const resolveConflicts = (): void => {
    if (draft === null || conflictPicks.size < conflicts.length) return;
    let next = draft;
    conflicts.forEach((conflict, index) => { if (conflictPicks.get(index) === 'THEIRS') next = conflict.useTheirs(next); });
    draft = next;
    conflicts = [];
    conflictOpen = false;
    const then = afterConflicts;
    afterConflicts = undefined;
    paintConflicts();
    buildAll();
    save(then);
  };
  const paintConflicts = (): void => {
    conflictLayer.dataset.show = String(conflictOpen);
    conflictRows.replaceChildren();
    conflictSave.disabled = conflictPicks.size < conflicts.length;
    conflictSave.dataset.can = String(!conflictSave.disabled);
    if (!conflictOpen) return;
    conflicts.forEach((conflict, index) => {
      const row = h('div', 'pf-conflict-row');
      row.append(h('span', 'pf-conflict-label', conflictLabel(conflict)));
      const choices = h('div', 'pf-conflict-choices');
      for (const side of ['MINE', 'THEIRS'] as const) {
        const value = conflictValue(conflict, side === 'MINE' ? conflict.mine : conflict.theirs);
        const choice = tb('pf-conflict-pick', () => { conflictPicks.set(index, side); paintConflicts(); },
          side === 'MINE' ? P.conflict.mine(value) : P.conflict.theirs(value));
        choice.dataset.pick = side;
        choice.setAttribute('aria-pressed', String(conflictPicks.get(index) === side));
        choice.dataset.on = String(conflictPicks.get(index) === side);
        choices.append(choice);
      }
      row.append(choices);
      conflictRows.append(row);
    });
  };
  /** 这一项叫什么：编辑器上那一栏的名字；经历、教育带上是哪一段。 */
  const conflictLabel = (conflict: DraftConflict<AnyDraft>): string => {
    if (conflict.key === 'phone') return P.fields.phone;
    if (conflict.key === 'salary') return P.fields.salary;
    if (conflict.key === 'langs') return `${P.fields.langs} · ${conflict.lang ?? ''}`;
    if (conflict.key === 'consent') return P.sections.consent;
    if (conflict.key === 'resume') return P.sections.resume;
    const sec = SCHEMA.find((item) => item.entries === conflict.key);
    if (sec !== undefined) {
      const title = conflict.entry?.title !== undefined && conflict.entry.title !== ''
        ? conflict.entry.title
        : conflict.key === 'exp' ? P.newExperience : P.newEducation;
      const field = conflict.field === undefined ? undefined : (sec.ef ?? []).find((fd) => fd.k === conflict.field)?.l;
      return [sec.title, title, field].filter((part) => part !== undefined && part !== '').join(' · ');
    }
    for (const item of SCHEMA) {
      const fd = (item.fields ?? []).find((field) => field.k === conflict.key);
      if (fd !== undefined) return fd.l;
    }
    return conflict.key;
  };
  /** 这一项的一边写成一句给人看的话（选项写选项上的字，空着写「（空）」，删掉写「（删掉这一段）」）。 */
  const conflictValue = (conflict: DraftConflict<AnyDraft>, value: unknown): string => {
    const clip = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text);
    if (value === null && conflict.entry !== undefined && conflict.field === undefined) return P.conflict.removed;
    if (value === null || value === undefined) return P.conflict.empty;
    if (conflict.key === 'phone') {
      const { phoneCc, phone } = value as { phoneCc?: string; phone?: string };
      return phone === undefined || phone === '' ? P.conflict.empty : clip(`${phoneCc ?? ''} ${phone}`.trim());
    }
    if (conflict.key === 'salary') {
      const { salary, currency, period } = value as { salary?: string; currency?: string; period?: string };
      if (salary === undefined || salary === '') return P.conflict.empty;
      const per = period === 'month' ? P.options.periods.month : period === 'hour' ? P.options.periods.hour : P.options.periods.year;
      return clip(`${salary} ${currency ?? ''} · ${per}`);
    }
    if (conflict.key === 'consent') return value === true ? P.on : P.off;
    if (conflict.key === 'resume') return clip(resumes?.items.find((item) => item.id === value)?.name ?? (value === '' ? P.conflict.empty : String(value)));
    if (conflict.entry !== undefined && conflict.field === undefined) {
      const entry = value as Record<string, unknown>;
      return clip(String(entry.school ?? [entry.title, entry.company].filter((part) => typeof part === 'string' && part !== '').join(' · ')));
    }
    const fd = conflict.entry !== undefined
      ? SCHEMA.find((item) => item.entries === conflict.key)?.ef?.find((field) => field.k === conflict.field)
      : SCHEMA.flatMap((item) => item.fields ?? []).find((field) => field.k === conflict.key);
    const say = (one: unknown): string => {
      if (typeof one === 'boolean') return one ? P.options.yes : P.options.no;
      const text = String(one);
      return fd?.o?.find(([option]) => option === text)?.[1] ?? (fd?.t === 'month' ? text.replace('-', '.') : text);
    };
    if (Array.isArray(value)) return value.length === 0 ? P.conflict.empty : clip(value.map(say).join(P.conflict.joiner));
    if (value === '') return P.conflict.empty;
    return clip(say(value));
  };

  // ── 对外 ───────────────────────────────────────────────────────
  const shadowActive = (): Element | null => (element.getRootNode() as ShadowRoot | Document).activeElement ?? null;

  /** 上一个人的那一份连同没存的修改、没选的冲突一起丢掉（换了人，2026-10-04）。 */
  const forget = (): void => {
    loadSerial += 1;
    generation += 1;
    recheckAfterSave = false;
    status = 'loading';
    freshness = 'fresh';
    readAt = null;
    staleCode = '';
    snapshot = null;
    base = null;
    draft = null;
    eeoRecord = null;
    eeoAvailable = false;
    consentAvailable = false;
    resumes = null;
    errors = {};
    conflicts = [];
    justSaved = false;
    confirmOpen = false;
    conflictOpen = false;
    afterConflicts = undefined;
    paintConfirm();
    paintConflicts();
    // 左边导航上的名字、邮箱、首字母是上一个人的：换回人形图标、清空。
    setText(railName, '');
    setText(railMail, '');
    written.delete(railAvatar);
    railAvatar.replaceChildren(icon(doc, 'person', 16, { stroke: 1.8 }));
    buildAll();
  };

  return {
    element,
    open: () => {
      active = 'basic';
      openEntries.clear();
      scroller.scrollTop = 0;
      void load();
    },
    forget: (reopen: boolean) => {
      forget();
      if (reopen) void load();
    },
    revalidate: () => {
      // 只在摆着一份、没在存、他也没在选冲突时再对一次；结果照「后台换新」那一套处理。
      if (status !== 'ready' || saving || conflictOpen || freshness === 'checking') return;
      void load();
    },
    requestLeave: () => {
      if (hud !== '' || saving) return false;
      if (dirtyTotal() === 0) return true;
      confirmOpen = true;
      paintConfirm();
      if (!deps.reduced()) animate(confirmBox, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT });
      return false;
    },
    handleEscape: () => {
      if (conflictOpen) { closeConflicts(); return true; }
      if (!confirmOpen) return false;
      confirmOpen = false;
      paintConfirm();
      return true;
    },
    save: () => save(),
    layout: (width: number) => {
      const next = width >= 720;
      rail.style.display = next ? 'block' : 'none';
      if (next !== railVisible) {
        railVisible = next;
        if (status === 'ready') buildAll();
      }
    },
  };
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  if (/[\u3400-\u9fff]/u.test(trimmed[0] ?? '')) return trimmed[0] ?? '';
  // 头尾两个词的首字母；括号、标点不算（「Yuxin (Yuchen) Lou」→ YL）。
  const words = trimmed.split(/\s+/u).map((word) => word.replace(/[^\p{L}\p{N}]/gu, '')).filter((word) => word !== '');
  if (words.length === 0) return '';
  const first = words[0] ?? '';
  const last = words.length > 1 ? words[words.length - 1] ?? '' : '';
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

/** 草稿只有字符串、数字、布尔、数组与普通对象：逐层拷一份，不经过 JSON 解析（那是具名特权）。 */
function structuredCloneSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => structuredCloneSafe(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = structuredCloneSafe(item);
    return out as T;
  }
  return value;
}
