/**
 * L0 · 本地 UA-2 生产者 —— 不走网络也答得出「这个控件是什么」。
 *
 * UA-2 的判断只用 UA-1 那份 value-free 证据：autocomplete 记号、控件自身的
 * type/role、以及可及名称。这个判断是确定性的，所以它不必是一次网络往返；
 * 一张后端从没见过的页面，本地算出来的分类与后端算出来的应当一致。
 *
 * 这个模块的存在意义是：**没有站点规则的页面也能得到规范字段**。
 * 下游 `classifyQuestions` 要的正是 `Map<identityDigest, PilotUa2Classification>`，
 * 所以整条语义编译链不必改一行就能接上。
 *
 * 它不授予任何东西。UA-2 的输出永远只是推断，写入授权仍然是 UA-4 的事。
 *
 * ## 与已部署后端的两处**故意**不同
 *
 * 1. **三个链接字段**。契约发布了 LINKEDIN_URL / GITHUB_URL / PORTFOLIO_URL，
 *    档案侧也有独立的 linkedinUrl / githubUrl / portfolioUrl，T3 同样发布
 *    LINKEDIN / GITHUB / PORTFOLIO 三种链接类型；但已部署的分类器两张匹配表里
 *    一条都没有，于是每块申请板上的 LinkedIn 栏一律 UNRESOLVED，档案供得出的
 *    东西表达不出来。argoland 的 SEMANTIC_FIELDS 需要补上同样三条。
 *
 * 2. **蜜罐文案一票否决**。已部署的 URL 规则是
 *    `/\b(?:portfolio|website|personal site|url)\b/`，而 Workday 的 beecatcher
 *    label 正是 “Enter **website**. This input is for robots only…” —— 后端会把
 *    它判成 CANONICAL_FIELD/URL，通用填写据此把用户真实网址送进蜜罐，整份申请
 *    被静默当作 bot 流量丢弃，用户端零报错。见 `../dict/guards.ts`。
 *
 * ## 这里只挡得住三层防线中的第一层
 *
 * 蜜罐要靠**文案 / 属性身份 / 几何**三层，任一命中即拒。UA-1 的控件形状只带
 * label 与 accessibleName，既没有 `name`/`id`/`data-automation-id`，也没有几何，
 * 所以②③两层在这里无从判断，**必须**继续由持有真实元素的 Extension 适配器执行。
 * 本模块不构成蜜罐防护的充分条件。
 */

import type {
  PilotUa1VisibleControl,
  PilotUa2CanonicalField,
  PilotUa2Classification,
} from '@edaix/contracts/draft';
import {
  isHoneypot,
  isJobDependentField,
  isOtherPersonField,
  normalizeGuardText,
} from '../dict/guards.ts';
import type { Digest } from './grouping.ts';

type Decision = Readonly<{
  kind: PilotUa2Classification['kind'];
  canonicalField: PilotUa2CanonicalField | null;
  confidence: PilotUa2Classification['confidence'];
  source: PilotUa2Classification['provenance']['source'];
  reasonCode: PilotUa2Classification['reasonCode'];
}>;

/** 与已部署后端逐条对齐；新增一条必须两边同时加，否则同一页会有两种答案。 */
const AUTOCOMPLETE_FIELDS: Readonly<Record<string, PilotUa2CanonicalField>> = Object.freeze({
  name: 'NAME_FULL',
  'given-name': 'NAME_GIVEN',
  'family-name': 'NAME_FAMILY',
  email: 'EMAIL',
  tel: 'PHONE',
  'tel-national': 'PHONE',
  'street-address': 'ADDRESS_LINE_1',
  'address-line1': 'ADDRESS_LINE_1',
  'address-line2': 'ADDRESS_LINE_2',
  'address-level2': 'CITY',
  'address-level1': 'REGION',
  'postal-code': 'POSTAL_CODE',
  country: 'COUNTRY',
  'country-name': 'COUNTRY',
  organization: 'ORGANIZATION',
  'organization-title': 'JOB_TITLE',
  url: 'URL',
});

/** 与已部署后端逐条对齐。三条链接规则不在这张表里，见 `namedPrimaryLinkField`。 */
const SEMANTIC_FIELDS: readonly Readonly<{
  field: PilotUa2CanonicalField;
  pattern: RegExp;
}>[] = Object.freeze([
  { field: 'EMAIL', pattern: /\b(?:e[ -]?mail|email address)\b/u },
  { field: 'PHONE', pattern: /\b(?:phone|telephone|mobile)\b/u },
  { field: 'NAME_GIVEN', pattern: /\b(?:first|given) name\b/u },
  { field: 'NAME_FAMILY', pattern: /\b(?:last|family|surname)\b/u },
  { field: 'NAME_FULL', pattern: /\bfull name\b/u },
  { field: 'ADDRESS_LINE_1', pattern: /\b(?:street address|address line 1)\b/u },
  { field: 'ADDRESS_LINE_2', pattern: /\baddress line 2\b/u },
  { field: 'POSTAL_CODE', pattern: /\b(?:postal|zip) code\b/u },
  { field: 'CITY', pattern: /\bcity\b/u },
  { field: 'REGION', pattern: /\b(?:state|province|region)\b/u },
  { field: 'COUNTRY', pattern: /\bcountry\b/u },
  { field: 'ORGANIZATION', pattern: /\b(?:company|organization|employer)\b/u },
  { field: 'JOB_TITLE', pattern: /\b(?:job title|position title|current title)\b/u },
  { field: 'URL', pattern: /\b(?:portfolio|website|personal site|url)\b/u },
]);

export function classifyControlsLocally(
  controls: readonly PilotUa1VisibleControl[],
  semanticDigest: Digest,
): ReadonlyMap<string, PilotUa2Classification> {
  const out = new Map<string, PilotUa2Classification>();
  for (const control of controls) {
    out.set(control.identityDigest, classifyControlLocally(control, semanticDigest));
  }
  return out;
}

export function classifyControlLocally(
  control: PilotUa1VisibleControl,
  semanticDigest: Digest,
): PilotUa2Classification {
  const decision = decide(control);
  return Object.freeze({
    identityDigest: control.identityDigest,
    kind: decision.kind,
    canonicalField: decision.canonicalField,
    confidence: decision.confidence,
    provenance: Object.freeze({
      source: decision.source,
      semanticDigest: semanticDigest(valueFreeSignals(control)),
    }),
    reasonCode: decision.reasonCode,
  });
}

function decide(control: PilotUa1VisibleControl): Decision {
  if (control.inputType === 'password') return control_('HUMAN_ACTION_REQUIRED', 'HUMAN_PASSWORD_CONTROL');
  if (control.inputType === 'submit') return control_('HUMAN_ACTION_REQUIRED', 'HUMAN_SUBMIT_CONTROL');
  if (
    control.role === 'button' ||
    control.inputType === 'button' ||
    control.inputType === 'reset' ||
    control.inputType === 'image'
  ) return control_('HUMAN_ACTION_REQUIRED', 'HUMAN_ACTION_CONTROL');

  // 蜜罐压过后面所有证据，包括 autocomplete 的 HIGH：宿主把 `autocomplete="email"`
  // 挂在陷阱上是免费的，而填错一次的代价是整份申请被丢弃。
  if (isHoneypotCaption(control)) return unresolved();

  for (let index = control.autocomplete.length - 1; index >= 0; index -= 1) {
    const canonicalField = AUTOCOMPLETE_FIELDS[control.autocomplete[index]!];
    if (canonicalField) {
      return Object.freeze({
        kind: 'CANONICAL_FIELD',
        canonicalField,
        confidence: 'HIGH',
        source: 'AUTOCOMPLETE',
        reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
      });
    }
  }

  if (
    control.role === 'combobox' ||
    control.role === 'listbox' ||
    control.role === 'radiogroup' ||
    control.role === 'radio' ||
    control.role === 'checkbox' ||
    control.role === 'switch' ||
    control.inputType === 'select-one' ||
    control.inputType === 'select-multiple' ||
    control.inputType === 'radio' ||
    control.inputType === 'checkbox' ||
    control.inputType === 'color'
  ) return control_('STRUCTURED_CHOICE', 'STRUCTURED_CHOICE_CONTROL');

  if (
    control.inputType === 'date' ||
    control.inputType === 'datetime-local' ||
    control.inputType === 'month' ||
    control.inputType === 'time' ||
    control.inputType === 'week'
  ) return control_('STRUCTURED_DATE', 'STRUCTURED_DATE_CONTROL');

  if (
    control.inputType === 'number' ||
    control.inputType === 'range' ||
    control.role === 'spinbutton' ||
    control.role === 'slider'
  ) return control_('STRUCTURED_NUMBER', 'STRUCTURED_NUMBER_CONTROL');

  if (control.inputType === 'file') return control_('STRUCTURED_FILE', 'STRUCTURED_FILE_CONTROL');
  if (control.inputType === 'textarea') return control_('OPEN_QUESTION', 'OPEN_QUESTION_CONTROL');

  const direct = control.inputType === 'email'
    ? 'EMAIL'
    : control.inputType === 'tel'
      ? 'PHONE'
      : control.inputType === 'url'
        ? 'URL'
        : null;
  if (direct) return semantic(direct);

  const named = namedPrimaryLinkField(control);
  if (named !== null) return semantic(named);

  const text = semanticText(control);
  // 不是标签形状（问句、整句话、或超过 6 个词）就只认锚定到某一段的匹配。
  if (isQuestionCaption(text)) {
    for (const segment of questionSegments(text)) {
      for (const candidate of SEMANTIC_FIELDS) {
        if (anchored(candidate.pattern).test(segment)) return semantic(candidate.field);
      }
    }
    return unresolved();
  }
  for (const candidate of SEMANTIC_FIELDS) {
    if (candidate.pattern.test(text)) return semantic(candidate.field);
  }
  return unresolved();
}

/**
 * 一句**问applicant的话**不是字段标签。
 *
 * 实测于 jobs.channable.com（Recruitee）：
 * 「Which one of our **company** values resonates the most with you and why?」
 * 命中了 ORGANIZATION 那条 `/\b(?:company|organization|employer)\b/`，于是通用填写
 * 会把用户的现任公司名写进一道问答题里。这类误判比填不上难看得多——它出现在
 * 招聘方读得到的地方。
 *
 * 所以问句改走**分段锚定**：按问号与括号切开，某一段整体就是那个字段名才算数。
 * 沿用仓里既有的「宁可漏判也不要误判」。同一页上
 * 「Where do you live? (City)」照样成立——它的 `city` 段整体锚得住。
 */
function isQuestionCaption(text: string): boolean {
  const trimmed = text.trim().replace(/\*+$/u, '').trim();
  return (
    /[?？]/u.test(trimmed) ||
    /[.。]$/u.test(trimmed) ||
    /[.。]\s/u.test(trimmed) ||
    countWords(trimmed) > LABEL_MAX_WORDS
  );
}

/**
 * 一个字段标签是短名词短语，不是一句话。
 *
 * 阈值量自 352 个真实申请页上 1314 条必填自定义问题标签：本地 UA-2 原本认出 221
 * 条，这条判据筛掉 43 条，**逐条核对全是该筛的**——「Are you currently legally
 * authorized to work in the country…」是签证题不是国家栏，「Describe the last
 * piece of code you wrote」被判成姓氏，「Team member 2 first and last name」是
 * 别人的名字。剩下 178 条（Country / Company name / Current Employer /
 * Legal First Name …）是真的。
 *
 * 5 词与 6 词给出同一批结果，说明不是卡在边界上过拟合；取 6 更宽松，宁可漏筛
 * 也不误筛。
 */
const LABEL_MAX_WORDS = 6;

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;
}

function questionSegments(text: string): readonly string[] {
  return text
    .split(/[?？()（）]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function anchored(pattern: RegExp): RegExp {
  return new RegExp(`^(?:${pattern.source})$`, pattern.flags);
}

/** 后端读的是同样这三处文字，蜜罐判断不该比分类判断看得少。 */
function semanticText(control: PilotUa1VisibleControl): string {
  return [control.accessibleName, control.label, control.legend]
    .filter((value): value is string => value !== null)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}

/**
 * `isHoneypot` 才是三层防线的正式入口；`mustNeverAutofill` 在 guards 里被明确
 * 标注为「零调用方、名字像终极拒绝门但只有两层」，新代码不得采用。这里只供得起
 * `text` 一层——UA-1 的控件形状不带属性身份，也不带几何——另外两层仍由持有真实
 * 元素的 Extension 适配器执行。
 */
function isHoneypotCaption(control: PilotUa1VisibleControl): boolean {
  const text = captionsOf(control).join(' ');
  return text !== '' && isHoneypot({ text });
}

function captionsOf(control: PilotUa1VisibleControl): readonly string[] {
  return [control.accessibleName, control.label, control.legend]
    .filter((value): value is string => value !== null && value.trim() !== '');
}

/**
 * 三个链接字段只认**完整问法**，不认片段。
 *
 * 松匹配 `/\blinkedin\b/` 会把「How did you hear about us? (LinkedIn, Indeed…)」
 * 判成 LinkedIn 网址栏，于是用户的领英主页被填进一个来源问题里。锚定到整条
 * caption，并要求 accessibleName / label / legend 三处**彼此不矛盾**。
 *
 * 与后端 `main` 仓那版逐字同形。唯一省掉的是 `formalKindOfShape` 的
 * `TEXT_SINGLE` 判断：这里的调用点排在所有结构化分支之后，能走到这一步的
 * 控件已经必然是单行文本。
 */
const NAMED_LINK_CAPTIONS: readonly Readonly<{
  field: PilotUa2CanonicalField;
  pattern: RegExp;
}>[] = Object.freeze([
  { field: 'LINKEDIN_URL', pattern: /^(?:your )?linkedin(?: profile)?(?: (?:url|link))?$/u },
  { field: 'GITHUB_URL', pattern: /^(?:your )?github(?: profile)?(?: (?:url|link))?$/u },
  { field: 'PORTFOLIO_URL', pattern: /^(?:your )?(?:personal )?portfolio(?: (?:url|link))?$/u },
]);

function namedPrimaryLinkField(control: PilotUa1VisibleControl): PilotUa2CanonicalField | null {
  if (![null, 'text', 'url'].includes(control.inputType)) return null;
  // autocomplete 已经说了别的，就不由 caption 改判；`url` 太笼统，不算「说了别的」。
  if (control.autocomplete.some((token) => AUTOCOMPLETE_FIELDS[token] && token !== 'url')) return null;

  const captions = captionsOf(control);
  if (captions.length === 0) return null;
  const context = captions.join(' ');
  if (isOtherPersonField(context) || isJobDependentField(context)) return null;

  let field: PilotUa2CanonicalField | null = null;
  for (const text of captions) {
    const caption = normalizeGuardText(text);
    const hit = NAMED_LINK_CAPTIONS.find(({ pattern }) => pattern.test(caption));
    if (hit === undefined || (field !== null && field !== hit.field)) return null;
    field = hit.field;
  }
  return field;
}

function control_(
  kind: Exclude<PilotUa2Classification['kind'], 'CANONICAL_FIELD' | 'UNRESOLVED'>,
  reasonCode: PilotUa2Classification['reasonCode'],
): Decision {
  return Object.freeze({
    kind,
    canonicalField: null,
    confidence: 'HIGH',
    source: 'CONTROL_SEMANTICS',
    reasonCode,
  });
}

function semantic(canonicalField: PilotUa2CanonicalField): Decision {
  return Object.freeze({
    kind: 'CANONICAL_FIELD',
    canonicalField,
    confidence: 'MEDIUM',
    source: 'CONTROL_SEMANTICS',
    reasonCode: 'CANONICAL_SEMANTIC_MATCH',
  });
}

/**
 * 契约的 reason code 表里没有「蜜罐」这一项，而 wire 形状的权威在 argoland，
 * 本仓不得单方面加值。所以蜜罐先与其他判不出来的控件共用 UNRESOLVED：安全的那
 * 一半已经到位（不会被当成可填字段），缺的只是可区分的诊断码。
 */
function unresolved(): Decision {
  return Object.freeze({
    kind: 'UNRESOLVED',
    canonicalField: null,
    confidence: 'LOW',
    source: 'CONTROL_SEMANTICS',
    reasonCode: 'SEMANTIC_CLASSIFICATION_UNRESOLVED',
  });
}

/** 与后端逐字段同形，两边算出来的 semanticDigest 必须一致。 */
function valueFreeSignals(control: PilotUa1VisibleControl): string {
  return JSON.stringify({
    role: control.role,
    inputType: control.inputType,
    autocomplete: control.autocomplete,
    required: control.required,
    accessibleName: control.accessibleName,
    label: control.label,
    legend: control.legend,
    options: control.options.map((option) => ({
      identityDigest: option.identityDigest,
      accessibleName: option.accessibleName,
    })),
  });
}
