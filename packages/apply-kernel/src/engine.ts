/**
 * 填充引擎：把「适配器读到的表单」+「用户资料」变成一份**待确认的计划**。
 *
 * 这一层完全不认识任何 ATS —— 它只吃中立的 `ApplyFormDescriptor`
 * （通用铁律 1 的边界），因此可以用 fixture 单测，且新增厂商时无需改动。
 *
 * 关键设计：**引擎只产出计划，不写任何东西**。写入必须由用户在我们自己的
 * Shadow UI 里点击后，另行调用 runner —— 这是铁律 3 修订的前提条件之一
 * （"仅限用户显式点击后"），把"决定填什么"和"真的去填"彻底分开。
 */

import { questionContextOf } from './questions';
import { isCollectionFieldRole, isCurrentRow, isDatePartRole, projectCollectionField, siblingDatePartRole } from './collectionProjection';
import { flatValueCandidates } from './dict/fillKeyChoices';
import { canonicalLinkedInProfileUrl } from './dict/linkedinProfileUrl';
import { isPhoneDeviceTypeField, PHONE_DEVICE_TYPE_CANDIDATES } from './dict/phoneDeviceType';
import {
  SIGN_ON_BEHALF_COMBOBOX_ANSWERS,
  consentOnBehalfKind,
  consentTopicTitle,
  employerContactAnswer,
  employerContactCheckboxKind,
  employerContactSubject,
  isWholeQuestionKind,
  privacyNoticeTitle,
  signOnBehalfCheckboxKind,
  signOnBehalfChoiceAnswer,
  signOnBehalfChoiceKind,
  signatureFieldKind,
  widenedConsentKind,
  widenedTopicTitle,
  type EmployerContactAnswer,
  type SignOnBehalfKind,
} from './dict/signOnBehalf';
import { dateShapeOfInputType } from './dateFormat';
import { fieldRowIndex, readValue } from './fieldIdentity';
import type { ApplyProfileCollections } from './profileCollections';
import { capabilitiesForKinds } from './write/allowlist';
import type { WriteCapability } from './grant';
import { assertNever, MAX_SEARCH_PROMPT_VALUES } from './contracts';
import type {
  ApplyErrorCode,
  ApplyFieldDescriptor,
  ScanRoot,
  FieldSignature,
  ApplyFieldKey,
  ApplyFormDescriptor,
  ApplyPlan,
  ApplyPlanEntry,
  ApplyEntryKey,
  QuestionAnswerKey,
  ComboboxOptionHarvest,
  HistoryAnswerBasis,
} from './contracts';
import {
  isHoneypot,
  isHoneypotGeometry,
  isCoverLetterField,
  isCoverLetterFileField,
  isManualOnlyControl,
  isNeverWritableControl,
  isJobDependentField,
  isNonResumeFileField,
  isOtherPersonField,
  isReferralField,
  isReferralNameField,
  type HoneypotGeometry,
  isPhoneMetaField,
  isPhoneCountryCodeField,
  isUserOnlyQuestion,
} from './dict/guards';
import { hasApprovedCoverLetterFileIdentity, hasApprovedResumeFileIdentity } from './write/setFile';
import {
  deriveProfile,
  type ApplyProfileDraft,
  type SuppressedFieldKeys,
} from './profileDraft';
import { dateSegmentGroup, resolveSelectOption } from './write/setValue';
import { selectProxyOf } from './write/ariaComboboxGeneric';
import { nationalPhoneNumber, phoneCallingCode } from './write/verify';
import { chosenOptions, isSingleChoiceGroup, sameText } from './write/choiceGroup';
import { ariaProxyPressed } from './dict/ariaChoice';
import { hasPlainTextOnlyStructure } from './rules/plainTextContenteditable';
import {
  isBoundedComboboxHarvest,
  optionSetSignature,
  resolveOptionCandidate,
} from './click/optionSearch';
import {
  isHispanicOriginQuestion,
  lgbtqCommunityAnswer,
  selfIdentificationConcept,
  transgenderAnswer,
  type SelfIdentificationConcept,
} from './dict/selfIdentification';
import { selfIdentificationComboboxCandidates, selfIdentificationOption } from './dict/selfIdentificationOptions';
import type { HispanicLatinoAnswer, SexualOrientationAnswer, TransgenderAnswer } from './dict/selfIdentificationAnswers';
import { isCurrentResidenceQuestion, residenceRegion } from './dict/residence.ts';
import { answersYesToRelocation } from './dict/relocation.ts';
import {
  adultFromHistory,
  currentStudentAnswer,
  hiringCompanyEmployment,
  militaryServiceAnswer,
  normalizeCompany,
  notEmployedOption,
  transitioningServiceMemberAnswer,
} from './dict/historyAnswers';
import { experienceMonths, experienceOption, totalExperienceQuestion, wholeYears } from './dict/experienceYears';
import { languageListText, languageOptionsToCheck, languageYesNo } from './dict/languages';
import { workArrangementAnswer } from './dict/workArrangement';
import { travelAnswer } from './dict/travel';
import type { TravelPercent } from './profileV2Travel';
import {
  ageQuestion,
  asksAge,
  asksAgeAndWorkAuthorization,
  mixesAgeWithJobQuestion,
  type AgeQuestion,
} from './dict/ageQuestion';
import {
  namedWorkRegion,
  refersToResidence,
  workAuthorizationQuestionKind,
  type WorkAuthorizationQuestionKind,
} from './dict/workAuthorization';
import { countryDisplayNames, countryLocalNames, inferRegionCode, mentionsAnyRegion, subdivisionName } from './dict/regions';
import {
  callingCodeCountry,
  callingCodeOfOption,
  describesAnotherParty,
  isBareCountryCodeLabel,
  isBareIdentityPrompt,
  isBareJobTitleLabel,
  isBareNameLabel,
  isGenderAnswerSet,
  createSectionCaptioner,
  looksLikeCallingCodeOptions,
  sectionMentionsCollection,
} from './dict/fieldContext';

/**
 * 低于此置信度就不写，只在复核列表里提示。0.7 之上意味着信号来自
 * 稳定 id / autocomplete 声明 / 明确的标签文案，而不是模糊猜测。
 */
export const MIN_APPLY_CONFIDENCE = 0.7;

export interface BuildPlanOptions {
  /**
   * 用户按国家的工作许可，来自档案下发。每一条都已经由服务端判过「此刻成立」
   * （未撤销、已生效、未过期），所以内核不碰时间，也拿不到那三个时间戳。
   *
   * 发清单而不是一个布尔值：同一个用户在美国与加拿大可以答得完全相反，而国家要在
   * 「问题点名了哪个国家」那一刻才定——那是看到题目文本的时候。
   */
  workAuthorizations?: readonly Readonly<{
    regionCode: string;
    authorizedToWork: 'YES' | 'NO' | 'UNSPECIFIED';
    requiresSponsorship: 'YES' | 'NO' | 'UNSPECIFIED';
  }>[];
  /**
   * 岗位所在国家（ISO 3166-1 alpha-2），由调用方从申请卡片的地点**确定性**解出（P1-7）。
   * 只在工作授权题一个地方都没点名时用：题目说的是「这个岗位所在的国家」，那就按它答，
   * 且答出来的条目带 `inferredRegionCode`，面板据此写明「按岗位地点推断」。解不出恰好一个国家
   * 就别传——传了模糊值等于替用户向雇主陈述法律资格时猜了一个国家。
   */
  jobRegionCode?: string;
  /**
   * 岗位地点的原文（「Seattle, Washington」，调用方从页面的 JobPosting 读出，2026-09-24）。只给搬迁题用：
   * 题目没写搬去哪儿（「Are you local to or willing to relocate?」）时，拿它对他住的城市与他列的搬迁城市。
   * 不给就与从前一样，只看题面。
   */
  jobLocation?: string;
  /**
   * 用户**亲手**存的推荐人（P1-9）与本次申请的公司名（来自申请卡片）。推荐人栏只在「档案里恰好有
   * 一条推荐到这家公司的记录」时预填**姓名**，且一律 PREFILLED_NEEDS_CONFIRMATION；邮箱、电话、
   * 关系一律不代填。两样缺一样都不预填——推荐人栏按 OTHER_PERSON 跳过。
   *
   * 公司名还答「你在这家公司工作过吗／现在在这里吗」（2026-09-24，dict/historyAnswers.ts）：与 `collections`
   * 里的工作经历比对。不给就不答那一类。
   */
  referrals?: readonly Readonly<{ name: string; company: string }>[];
  jobCompany?: string;
  /**
   * 用户在门户里对「是否拉美裔」那一问**亲口**的回答（2026-09-23，`selfIdentificationCodesFromAnswers`）。
   * 「Are you Hispanic/Latino?」这道题有了它就照它答（是／否／不想回答）；没有它仍然只在种族码
   * 是拉美裔时答「是」——单值的种族推不出「否」。它不是扁平档案键，所以走这里。
   */
  hispanicLatino?: HispanicLatinoAnswer;
  /**
   * 用户在门户里对「是否跨性别」与性取向**亲口**的回答（2026-09-23，`selfIdentificationCodesFromAnswers`）。
   * 与 `hispanicLatino` 同理不是扁平档案键，走这里：跨性别题、性取向题照它答，「是否 LGBTQ+」由这两句
   * 推出（`lgbtqCommunityAnswer`）。缺省 = 没答、自行描述或没同意复用——那几道题交还用户。
   */
  transgenderStatus?: TransgenderAnswer;
  sexualOrientation?: SexualOrientationAnswer;

  /**
   * 只填空字段（默认开）。覆盖用户已经手打的内容是本功能**最严重**的
   * 失效模式——一个长表单填错能毁掉真实的工作量，所以默认保守。
   */
  fillEmptyOnly?: boolean;
  /**
   * 用户长期抑制的字段键（服务端 `suggestions.suppressedKeys` 的镜像，**只有键名**）。
   *
   * 传进来是为了让推导也守住删除承诺：`city` 会从 `location` 补、`fullName` 与
   * `firstName/lastName` 互推，只要还有一个相关字段有值，被删掉的那个就会在这里
   * 被重新算出来并填进雇主的申请表。见 `deriveProfile` 的说明。
   */
  suppressedKeys?: SuppressedFieldKeys;
  /**
   * 读一个控件的几何，供蜜罐第三道防线（`isHoneypotGeometry`）使用。
   *
   * **不给就不启用这道防线。** kernel 是确定性纯解释器，不碰浏览器 API
   * （RULE-KERNEL-DETERMINISTIC-BOUNDARY）——"当前环境会不会布局"是环境事实，
   * 由 DOM 侧的调用方声明并提供测量手段。Extension 的 content script 注入真实
   * 读取；单测注入形状；不注入则退回文案层与身份层两道防线。
   */
  readGeometry?: (element: Element) => HoneypotGeometry;
  /**
   * 用户当前简历的**文件名**，用于计划期展示与"这一栏能不能填"的判定。
   *
   * 只有文件名，不是文件本身——真正的 `File` 由 runner 在写入时向注入的取件函数
   * 索取。这样 `apply/` 层继续零网络零消息，也不会在计划里长期持有 L1 文件字节。
   *
   * 它**不是档案字段**：后端契约的 `fields` 是 11 个文本键，简历有自己的接口。
   */
  resumeFileName?: string;
  /**
   * 代填签名日期用的「当天」，ISO `YYYY-MM-DD`，由调用方按用户本地时区给出。内核不碰时钟
   * （RULE-KERNEL-DETERMINISTIC-BOUNDARY）；不给就不代填签名日期，那一栏交还本人。
   */
  signingDate?: string;
  /**
   * 用户本地的「当天」，ISO `YYYY-MM-DD`（2026-10-04）：按资料推「工作年限」（在职的那一段算到这个月）与「你现在在读吗」
   * 要用。内核不碰时钟（RULE-KERNEL-DETERMINISTIC-BOUNDARY）；不给就不答这两类（在读只答得出明确标了在读的「是」）。
   */
  today?: string;
  /**
   * 资料里「出差最多能接受多少？」确认过的回答（2026-10-04，argoland #738）：工作时间的百分比上限。出差题照它答
   * （dict/travel.ts）；不给 = 没答，出差题交还本人。它不是扁平档案键，走这里。
   */
  travelPercentMax?: TravelPercent;
  /**
   * 以用户名义代填时，这一轮获准的类别（2026-09-28）：`sign-on-behalf` 能力位之外的第二道。同意类只在用户同意了
   * 当前版本的代填授权时在里面（`SIGNING_CONSENT_KINDS`；同意的是旧版本就当没同意），能不能联系雇主只有资料里答过
   * 才在里面（`employerContactKinds`）——没同意代填授权、只答了那一问时，调用方只交那一向的两类。不给或为空
   * 就没有获准的类别；能力位不能代替逐项授权（联系雇主那几类另要 `employerContact`）。
   */
  signOnBehalfKinds?: ReadonlySet<SignOnBehalfKind>;
  /**
   * 用户在资料里对「可以联系你现在的雇主吗？」的回答（2026-09-28）。问能不能联系他现在的雇主的题照它答；题目只问
   * 以前的雇主或推荐人时照同一个回答答（dict/signOnBehalf.ts 的 `employerContactAnswer`）。不给 = 没答，这一类题
   * 交还本人。
   */
  employerContact?: EmployerContactAnswer;

  /**
   * 这一页的域名是否在厂商主机表里（`detectApplyVendor` 认得），或者用户已经在
   * 浮层里为**本次访问**确认过。
   *
   * 为什么只有简历这一栏受它约束（2026-08-03 对抗评审确认项 2）：A2b 的厂商识别
   * **刻意不认域名**——白标 ATS 和公司自建页需要这个。代价是那些指纹全是 DOM 特征
   * （`#grnhse_app`、`.ashby-application-form-container` 等），而**任何页面对自己的
   * DOM 有完全控制权**，伪造一份出来是零成本的。叠上内容脚本的注入范围是
   * 「全部 https 主机 + 全部子帧」，一个用户信任的网站里嵌的第三方 iframe 就能
   * 让我们的浮层出现在它自己的表单上。
   *
   * 这个风险你早就接受过了——针对的是 11 个文本键（姓名、邮箱、电话这些）。
   * A3 之后同一条链能拿到的变成**整份简历 PDF**：完整履历、住址，量级完全不同。
   * 所以门槛只加在简历上，文本字段维持原样：既保住 A2b 的覆盖面，又不让最值钱的
   * 那一件东西只靠一次 Fill 点击就送出去。
   *
   * 缺省 `false` 是**fail-closed**：调用方没表态就当作没确认。
   */
  resumeHostConfirmed?: boolean;
  /** Grounded Data-L1 body supplied by the future T9 authority; never inferred here. */
  coverLetterText?: string;
  /**
   * 求职信 PDF 的文件名（2026-09-27）：有它，求职信上传栏才进计划。与简历一样只有名字，字节由 runner 写入时向
   * `resolveCoverLetterFile` 索取；仍要 `coverLetterTargetVerified`。
   */
  coverLetterFileName?: string;
  /** Exact current Mission/target release; omission is fail closed. */
  coverLetterTargetVerified?: boolean;
  /**
   * 结构化档案（教育 / 经历 / 技能）。不给就等于「这一份档案没有分段内容」——
   * 行内字段一律 `NO_VALUE`，不会因此报错，也不会去猜。
   *
   * 它与 11 个扁平键分开传，因为它们是**两份契约**：`fields` 是后端
   * autofill 档案的 11 键，集合有自己的形状（见 profileCollections.ts）。
   *
   * 2026-09-24 起它还是两类推断答案的依据（dict/historyAnswers.ts）：档案里没有明确的 `over18` 时，
   * 有教育或工作经历就答「年满 18」；「你在这家公司工作过吗」按经历里的雇主答。
   */
  collections?: ApplyProfileCollections;
  /**
   * Stable option verdicts produced before review, keyed by the exact trigger.
   * Missing entries preserve the current nullable/disabled readiness lane.
   */
  comboboxHarvests?: ReadonlyMap<HTMLInputElement, ComboboxOptionHarvest>;
  /**
   * 生效中的能力位，**用于计划期的"这一类要不要进计划"判断**。
   *
   * 与 runner 的逐写能力检查是两件事：那个问「这个控件的写入原语获准了吗」
   * （set-text / set-combobox / set-file…），这个问「这一类问题获准由我们作答吗」。
   * 不传 = 与从前逐字相同（受能力位管辖的类别一律跳过），fail closed。
   */
  capabilities?: Readonly<Partial<Record<WriteCapability, boolean>>>;
}

/**
 * A plan is a short-lived in-memory object, so an opaque nonce is enough to
 * bind the user gesture without leaking any profile value into an identifier.
 * A fresh plan receives a fresh nonce; a reactive re-scan therefore cannot
 * silently reuse authority minted for the previous preview.
 */
function newPlanFingerprint(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `plan-${crypto.randomUUID()}`;
  }
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 一个字段的候选值，按「最可能被宿主接受」排序。
 *
 * 扁平键只有一个值；行内角色天然是**有序候选**——月份在 Greenhouse 的
 * `<select>` 里是 `March`、在 Workday 是 `03`，把某一种写死在这里就是把厂商
 * 知识搬进了 kernel（铁律 3）。哪一个真能落下由下面的阶梯匹配决定。
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * 文本框里的日期写法，按那一栏 placeholder 声明的掩码排序。
 *
 * 只认 `年月日` 三段、用 `/` 或 `-` 连接的常见掩码；认不出就把 ISO 排第一。
 * 后面仍然带上另外两种写法，供将来有阶梯的写入路使用；今天写入取首项。
 */
function maskedDateCandidates(iso: string, placeholder: string | null): readonly string[] {
  const parts = ISO_DATE.exec(iso);
  if (parts === null) return [iso];
  const [, year, month, day] = parts as unknown as [string, string, string, string];
  const hint = (placeholder ?? '').toLowerCase().replace(/\s+/gu, '');
  const joined = (separator: string, first: string, second: string): string =>
    `${first}${separator}${second}${separator}${year}`;
  const separator = hint.includes('-') && !hint.includes('/') ? '-' : '/';
  const us = joined(separator, month, day);
  const eu = joined(separator, day, month);
  if (/mm[/-]dd[/-]yyyy/u.test(hint)) return [us, iso, eu];
  if (/dd[/-]mm[/-]yyyy/u.test(hint)) return [eu, iso, us];
  return [iso, us, eu];
}

/**
 * 真的是自由文本框：`<textarea>`，或者 type 缺省／为 `text` 的 `<input>`。
 * `type=date` / `type=month` 由浏览器自己定格式，placeholder 在那里不作数。
 */
function isFreeTextInput(element: Element): boolean {
  if (element.tagName === 'TEXTAREA') return true;
  const type = (element.getAttribute('type') ?? 'text').toLowerCase();
  return type === 'text' || type === '';
}

function candidatesFor(
  field: Exclude<ApplyFieldDescriptor, { kind: 'unsupported' }>,
  key: ApplyEntryKey,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
  root: ScanRoot,
  collections: ApplyProfileCollections | undefined,
): readonly string[] {
  if (isCollectionFieldRole(key)) {
    if (collections === undefined) return [];
    // 闭集码只对**有选项集的控件**有意义：`<select>` 与 combobox 会拿候选逐个去
    // 撞宿主真有的选项，码最精确所以排第一。而自由文本框没有可撞的东西，
    // 取首项就等于把 `BACHELOR` 这种机器码写进用户的申请表——而且回读读到的
    // 正是它，`expected === actual` ⇒ 判成功、面板显绿。
    //
    // 所以这里按控件种类**换序**而不是换内容：码退到最后，仍然可用于
    // 后续的阶梯匹配，只是不再当首选。
    // 不在任何行里的行内字段按第 1 段读：宿主只渲染一段教育时不套行容器
    // 是常见写法，此时「没有行序」的意思是「就这一段」，不是「不知道哪一段」。
    // 搜索式多选上的技能（2026-09-24，Workday「Type to Add Skills」）：一项一个值，按档案顺序，最多 15 项
    // （部件自己声明的上限由写入器按框里已有几项把关）。别处的技能栏仍是一个逗号分隔的字符串（投影层的写法）。
    if (key === 'skills.all' && field.kind === 'combobox' && field.listbox?.searchPrompt) return (collections.skills ?? []).slice(0, MAX_SEARCH_PROMPT_VALUES);
    const rowIndex = fieldRowIndex(field.element, root) ?? 0;
    // 日期形态来自**那一个控件本身**（CAP-AF-002）：`<input type="date">` 只接受
    // YYYY-MM-DD、`type="month"` 只接受 YYYY-MM，写错就静默不生效——赋值被浏览器
    // 丢弃、读回来是空串，而用户看到的是「这一栏没填上」且不知道为什么。
    const candidates = projectCollectionField(
      collections,
      key,
      rowIndex,
      dateShapeOfInputType(field.element.getAttribute('type')),
    );
    // 分段日期缺一段（2026-09-24）：MM/YYYY 这种一个组里好几段的日期，宿主只收整个日期。资料里只有
    // 年份时写进去的是「/2021」，Workday 当场报 Invalid Date、页面红着——比空着更糟。所以同一组里另一段
    // 投影不出值时，这一段也不写，整组如实交给用户；只有一段的组（教育的 YYYY）不受影响。
    if (candidates.length > 0 && isDatePartRole(key) && missingSiblingSegment(field.element, key, collections, rowIndex)) {
      return [];
    }
    // GPA 落在数字框上（2026-09-28 D. E. Shaw：「GPA/Grade (Cumulative) Achieved」「… Total」都是 type=number）：
    // 资料里常写成「3.8/4.0」，数字框只收一个数——分数取斜杠前那一个，满分取斜杠后那一个（资料里没单独存满分时）。
    if ((key === 'education.gpa' || key === 'education.gpaScale') && field.element.getAttribute('type')?.toLowerCase() === 'number') {
      return gpaNumberCandidates(key, candidates, collections, rowIndex);
    }
    return field.kind === 'text' || field.kind === 'textarea'
      ? demoteEnumCodes(candidates)
      : candidates;
  }
  const value = resolved[key as ApplyFieldKey];
  if (!value) return [];
  const control = field.kind === 'text' || field.kind === 'textarea' ? 'text' : 'options';
  // 电话落在**选项控件**上、题目问的是设备类型：候选是「手机」的各种写法，不是号码本身
  // （产品决定，2026-09-22；见 dict/phoneDeviceType.ts）。有号码才有设备类型——上面那一行
  // 已经保证了 value 非空。
  if (key === 'phone' && control === 'options' && isPhoneDeviceTypeField(field.label)) {
    return PHONE_DEVICE_TYPE_CANDIDATES;
  }
  // 国家存的是 ISO 双字母码（argoland 2026-09-21 起），而申请表的国家下拉写的是国名：
  // 「US」在 react-select 里一个都撞不上（2026-09-21 Discord 页实测 NO_OPTION_MATCH）。
  // 国名在前、别名次之、码最后——码对 value 写成码的原生 <select> 仍然一次就中。
  if (key === 'addressCountry' && control === 'options') {
    // 英文名与别名之后，再试德、法、西、意、葡、荷文的国名（2026-09-28 Hetzner 的「Land」：Deutschland、
    // Vereinigte Staaten……）。英文页上它们撞不上任何一项，结果与从前一样。
    // 「国家 - 州」一项一州列出的（2026-09-28 Canonical：「United States of America - California」）：档案里有州／省时
    // 再试这几种写法；光是国名，几十项都以它开头，阶梯只会判成有歧义。
    const names = countryDisplayNames(value);
    const region = resolved.addressRegion?.trim() ? subdivisionName(resolved.addressRegion) : null;
    const withRegion = region === null ? [] : names.flatMap((name) => [`${name} - ${region}`, `${name}, ${region}`, `${name} (${region})`]);
    return [...new Set([...names, ...countryLocalNames(value), ...withRegion, value])];
  }
  // 日期落在**自由文本框**上时，格式由那一栏自己的 placeholder 说了算。
  //
  // 2026-09-22 真实批测：BambooHR 的 `Date Available` 是 `input[type=text]`、没有
  // name、只有 `placeholder="mm/dd/yyyy"`；我们照档案写 ISO，它的掩码当场改写成
  // 另一个日期，回读对不上 → 八页里六页 VALUE_COERCED。「写进去了又被改掉」比
  // 没写更糟：用户以为填了。
  //
  // 只对文本框生效。`type=date` 按 HTML 规范只接受 `YYYY-MM-DD`，听 placeholder
  // 的会被浏览器静默丢弃；`type=month` 同理。没有可读的掩码提示时仍写 ISO——
  // 06/11 在两种 locale 下读法相反，ISO 是唯一只有一种读法的写法。
  if (control === 'text' && isFreeTextInput(field.element) && ISO_DATE.test(value)) {
    return maskedDateCandidates(value, field.element.getAttribute('placeholder'));
  }
  // 州／省同理：档案里是 "AL"，而 BambooHR 那类的 State 下拉写的是 "Alabama"
  //（2026-09-22 真实实测）。全名在前、码垫底——把 value 写成码的下拉仍然一次就中。
  if (key === 'addressRegion' && control === 'options') {
    const name = subdivisionName(value);
    return name === null ? [value] : [name, value];
  }
  // 地点 typeahead（Greenhouse 的 Location (City)）只拿城市名去问，同名城市一多就是 AMBIGUOUS
  // （Birmingham 有两个）。档案里有州／省就先按「城市, 州名」问，再退回城市名。
  if ((key === 'city' || key === 'location') && field.kind === 'combobox') {
    const city = (key === 'city' ? value : resolved.city ?? value).trim();
    const region = resolved.addressRegion?.trim() ?? '';
    const regionName = region === '' ? null : subdivisionName(region);
    const withRegion = region === '' || city === '' || value.includes(',')
      ? []
      : [...(regionName === null ? [] : [`${city}, ${regionName}`]), `${city}, ${region}`];
    return [...new Set([...withRegion, ...flatValueCandidates(key as ApplyFieldKey, value, control)])];
  }
  // LinkedIn 个人页写 LinkedIn 自己的规范形式（dict/linkedinProfileUrl.ts）：不带 www 的写法
  // 在 Workday 上判 Invalid（2026-09-22 nvidia.wd5 实测），规范形式哪一家都认。原样写法垫在后面。
  if (key === 'linkedinUrl' && control === 'text') {
    const canonical = canonicalLinkedInProfileUrl(value);
    if (canonical !== null && canonical !== value) return [canonical, value];
  }
  // 闭集值（薪资周期、是否年满 18、办公模式……）展开成人读写法逐个去撞选项；
  // 没登记的键仍是原样一个候选。
  return flatValueCandidates(key as ApplyFieldKey, value, control);
}

/** 「3.8/4.0」「3.8 out of 4」→ 分数与满分；只认一个或两个数，别的写法不猜。 */
const GPA_FRACTION = /^\s*(\d+(?:[.,]\d+)?)\s*(?:(?:\/|out\s+of|of)\s*(\d+(?:[.,]\d+)?))?\s*$/iu;

function gpaNumberCandidates(
  key: 'education.gpa' | 'education.gpaScale',
  candidates: readonly string[],
  collections: ApplyProfileCollections,
  rowIndex: number,
): readonly string[] {
  const number = (text: string | undefined): string | null => (text === undefined ? null : text.replace(',', '.'));
  if (key === 'education.gpa') {
    const parsed = GPA_FRACTION.exec(candidates[0] ?? '');
    return parsed === null ? [] : [number(parsed[1])!];
  }
  const scale = GPA_FRACTION.exec(candidates[0] ?? '');
  if (scale !== null && scale[2] === undefined) return [number(scale[1])!];
  const fromGpa = GPA_FRACTION.exec(projectCollectionField(collections, 'education.gpa', rowIndex)[0] ?? '');
  const derived = number(fromGpa?.[2]);
  return derived === null ? [] : [derived];
}

/**
 * 把闭集码挪到候选末尾。
 *
 * 判据是**形态**而不是查表：闭集码一律是 `SCREAMING_SNAKE_CASE`（见
 * `profileCollections.ts` 的 `DEGREE_LEVELS` / `EMPLOYMENT_TYPES`），
 * 而人读写法从来不是。用形态判的好处是新增一个枚举不需要有人记得回来改这里——
 * 那正是这个仓被咬过好几次的形态。
 *
 * **退到末尾而不是删掉**——但要说清楚：文本框今天只取候选首项
 * （`candidatesFor(...)[0]`，没有阶梯匹配），所以对它而言降序与删除**行为完全相同**，
 * 没有任何测试能区分。选降序是因为候选列表本身是「这个值有哪些写法」的忠实描述，
 * 删掉会让它对将来的消费者说谎；不是因为降序能多救回什么。
 */
const ENUM_CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;

function demoteEnumCodes(candidates: readonly string[]): readonly string[] {
  const human = candidates.filter((value) => !ENUM_CODE_SHAPE.test(value));
  if (human.length === 0) return candidates;
  return [...human, ...candidates.filter((value) => ENUM_CODE_SHAPE.test(value))];
}

/** 这一段所在的分段日期组里还有别的段，而同一个日期的另一段（年 ↔ 月）投影不出值。 */
function missingSiblingSegment(
  element: Element,
  role: Parameters<typeof siblingDatePartRole>[0],
  collections: ApplyProfileCollections,
  rowIndex: number,
): boolean {
  const group = dateSegmentGroup(element);
  if (group === null || group.querySelectorAll('input[role="spinbutton"]').length < 2) return false;
  const sibling = siblingDatePartRole(role);
  return sibling === null || projectCollectionField(collections, sibling, rowIndex).length === 0;
}

/** 抑制键只对 11 个扁平键有意义——集合的删除承诺在后端那一侧。 */
function isSuppressed(keys: SuppressedFieldKeys | undefined, key: ApplyEntryKey): boolean {
  return !isCollectionFieldRole(key) && keys?.has(key as ApplyFieldKey) === true;
}

/**
 * 签名里的行标识那一段。签名形如 `tag|type|name|<行标识>|序号`。
 *
 * 取不到就返回空串（根域字段本来就是空的），于是根域内的重复仲裁行为逐字不变。
 */
function rowTagOf(signature: FieldSignature): string {
  return signature.core.split('|')[3] ?? '';
}

function planEntry(
  field: Exclude<ApplyFieldDescriptor, { kind: 'unsupported' } | { kind: 'richtext' }>,
  key: ApplyEntryKey,
  label: string,
  value: string,
  /** 扫描序号；审计面板靠它与 skipped 合并成表单顺序。 */
  order: number,
  /**
   * 覆盖描述符自带的置信度。
   *
   * 简历文件需要它：`resolveKey` 是按 11 个档案键匹配的，"Resume/CV" 一个都不中，
   * 所以描述符的 confidence 是 0——而 runner 会拿它跟 `policy.minConfidence`（0.7）
   * 比，把文件条目当成 LOW_CONFIDENCE 拦掉。实测就是这么失败的：计划里有条目、
   * 单测看着对，真跑起来文件从来没挂上去。
   *
   * 简历那一栏的判据是 `isResumeFileField` 这个**正向白名单**，命中即确定，
   * 与键匹配的置信度不是一回事。
   */
  confidenceOverride?: number,
  comboboxCandidates?: readonly string[],
  /**
   * 多选部件上，候选是不是**要逐个选上的几项**（审阅面板、记住的答案、AI 按行给的多选答案）。缺省 false：
   * 候选是同一个答案的几种写法（档案值、自我认同、工作授权的闭集写法），多选部件上只选一项（`singlePick`）。
   */
  candidatesAreValues = false,
): ApplyPlanEntry {
  const common = {
    key,
    label,
    value,
    order,
    // 从描述符原样带过来：runner 据此选写入通路。掉了它的后果是 typed 控件
    // 退回整串写入——宿主表单状态收不到，而回读读到的恰好是对的，
    // 于是把失败报成成功（50-证据库 §F.6-s）。
    ...(field.writeMode === undefined ? {} : { writeMode: field.writeMode }),
    required: field.required,
    confidence: confidenceOverride ?? field.confidence,
    signature: field.signature,
  };
  switch (field.kind) {
    case 'text':
      return { ...common, kind: field.kind, element: field.element };
    case 'textarea':
      return { ...common, kind: field.kind, element: field.element };
    case 'select':
      return { ...common, kind: field.kind, element: field.element };
    case 'combobox':
      return {
        ...common,
        kind: field.kind,
        element: field.element,
        ...(field.semanticAuthority === undefined
          ? {}
          : { semanticAuthority: field.semanticAuthority }),
        ...(field.listbox === undefined ? {} : { listbox: field.listbox }),
        // A multi-value search prompt (Skills) only ever receives values, one search each.
        ...(field.multiple ? { multiple: true, ...(candidatesAreValues || field.listbox?.searchPrompt ? {} : { singlePick: true as const }) } : {}),
        comboboxCandidates: Object.freeze([...(comboboxCandidates ?? [value])]),
      };
    case 'file':
      // 规则声明的上传部件（2026-09-28）：runner 写完之后按它确认宿主收下了这一份。
      return { ...common, kind: field.kind, element: field.element, ...(field.upload === undefined ? {} : { upload: field.upload }) };
    case 'choice':
      return { ...common, kind: field.kind, element: field.element, choice: field.choice };
    default:
      return assertNever(field, 'planEntry field kind');
  }
}

function plainTextContenteditablePlanEntry(
  field: Extract<ApplyFieldDescriptor, { kind: 'richtext' }>,
  label: string,
  value: string,
  order: number,
): ApplyPlanEntry | null {
  const attestation = field.plainTextContenteditableAttestation;
  if (!attestation) return null;
  return {
    key: 'coverLetter',
    label,
    value,
    order,
    required: field.required,
    confidence: 1,
    signature: field.signature,
    kind: 'richtext',
    element: field.element,
    plainTextContenteditableAttestation: attestation,
  };
}

/** Derive the least-privilege write capabilities from the reviewed plan. */
export function capabilitiesForPlan(plan: ApplyPlan): ReadonlySet<WriteCapability> {
  const capabilities = new Set(capabilitiesForKinds(plan.entries.map((entry) => entry.kind)));
  // 藏起来的原生下拉由它旁边的 ARIA 触发器代选（2026-09-28）：那是点击，要点击那一位。
  if (plan.entries.some((entry) => entry.kind === 'select' && entry.selectProxy !== undefined)) capabilities.add('set-combobox');
  return capabilities;
}

/**
 * 这张表自己有没有国际区号控件。
 *
 * 一次扫描面级的判断，与逐字段无关：只要表里存在一个「Country Phone Code」
 * 这样的控件，电话栏要的就是国内号段。判据只看已扫到的控件标签（不看是不是
 * 必填、不看填没填），因为「表自己管区号」是**表的结构事实**。
 */
function hasOwnCallingCodeControl(form: ApplyFormDescriptor): boolean {
  return form.fields.some((field) => isPhoneCountryCodeField(field.label || '') || isCallingCodePicker(field));
}

/**
 * 电话的国际区号下拉（2026-09-28 Zalando 的必填「Country Code」，选项「Germany (+49)」「United States (+1)」）：
 * 一个原生下拉，题面说到区号（`isPhoneCountryCodeField`，或光秃秃的「Country Code」一类），选项多数带着区号。
 * 光秃秃的「Country Code」只看题面分不清是区号还是 ISO 国家码，所以选项必须像区号。
 */
function isCallingCodePicker(field: ApplyFieldDescriptor): field is Extract<ApplyFieldDescriptor, { kind: 'select' }> {
  if (field.kind !== 'select') return false;
  const label = field.label || '';
  if (!isPhoneCountryCodeField(label) && !isBareCountryCodeLabel(label)) return false;
  return looksLikeCallingCodeOptions([...field.element.options].map((option) => option.text));
}

/**
 * 区号下拉上该选的那一项：号码自己写明的区号（`+1 415…` → 1），恰好一项带这个区号就选它；好几项共用（+1 是
 * 美国、加拿大、一串加勒比国家）就再按居住国的国名收窄到恰好一项。号码没写区号、对不上、收不窄，都不选。
 */
function callingCodeOption(
  field: Extract<ApplyFieldDescriptor, { kind: 'select' }>,
  phone: string | undefined,
  country: string | undefined,
): Readonly<{ index: number; text: string }> | 'NO_VALUE' | 'NO_OPTION_MATCH' | 'AMBIGUOUS_OPTION' {
  const code = phone === undefined ? null : phoneCallingCode(phone);
  if (code === null) return 'NO_VALUE';
  const options = [...field.element.options];
  const coded = options.flatMap((option, index) => (callingCodeOfOption(option.text) === code && !option.disabled ? [index] : []));
  if (coded.length === 0) return 'NO_OPTION_MATCH';
  if (coded.length === 1) return { index: coded[0]!, text: options[coded[0]!]!.text.trim() };
  const names = country === undefined ? [] : [...countryDisplayNames(country), ...countryLocalNames(country)].map((name) => sameTextKey(name));
  const named = coded.filter((index) => {
    const text = sameTextKey(options[index]!.text.replace(/[(（]?\s*\+\s?\d{1,4}\s*[)）]?/gu, ''));
    return names.includes(text);
  });
  return named.length === 1 ? { index: named[0]!, text: options[named[0]!]!.text.trim() } : 'AMBIGUOUS_OPTION';
}

/**
 * 电话的国际区号**搜索式单选**（2026-09-28 adobe.wd5 的必填「Country Phone Code」，Workday 的 selectinput）：规则把它
 * 声明成一值的 searchPromptComboboxes，题面说到区号（`isPhoneCountryCodeField`）。选项要搜了才出来，计划期看不到，
 * 所以只看题面与绑定；光秃秃的「Country Code」分不清是区号还是 ISO 国家码，不认。
 */
function isCallingCodePrompt(field: ApplyFieldDescriptor, label: string): field is Extract<ApplyFieldDescriptor, { kind: 'combobox' }> {
  return field.kind === 'combobox' && field.multiple !== true && field.listbox?.searchPrompt?.maxValues === 1 &&
    isPhoneCountryCodeField(label);
}

/** 规则声明的这个部件里此刻选着的几项（`selectedValueSelector` 的文字，只读）。 */
function promptSelections(field: Extract<ApplyFieldDescriptor, { kind: 'combobox' }>): string[] {
  const binding = field.listbox;
  if (binding === undefined) return [];
  try {
    const container = field.element.closest(binding.valueContainerSelector);
    if (container === null) return [];
    return [...container.querySelectorAll(binding.selectedValueSelector)]
      .map((chip) => (chip.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .filter((text) => text !== '');
  } catch {
    return [];
  }
}

/**
 * 区号搜索式单选要搜的几种写法：「国名 (+号码写明的区号)」，国名按「最像选项原文」的顺序（英文全名在前，别名随后）。
 * 国名先看区号本身：只属于一个国家的区号（+86、+91、+82……，`callingCodeCountry`）就用那个国家——「地址在美国、
 * 手机 +86」的留学生（2026-10-01 起档案电话可以是任何国家）从前永远搜不到；几国共用的区号（+1、+7、+44……）照旧用
 * 居住国。号码没写区号就是空：不按地址猜区号（会拨错国家）。
 */
function callingCodePromptQueries(phone: string | undefined, country: string | undefined): Readonly<{ code: string; queries: readonly string[] }> | null {
  const code = phone === undefined ? null : phoneCallingCode(phone);
  if (code === null) return null;
  const owner = callingCodeCountry(code) ?? country;
  if (owner === undefined) return null;
  const queries = countryDisplayNames(owner).map((name) => `${name} (+${code})`);
  return queries.length === 0 ? null : { code, queries };
}

/** 比较国名用的口径：NFKC、折叠空白、不分大小写。 */
function sameTextKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * 同一节的判法（CAP-AF-045 仲裁用的那一个）：autocomplete 的 section 记号 → fieldset → 最近的前置标题 → 整表一节。
 * 提到计划循环之前：几种题面要先看同一节里还有什么（`contextualKeys`）。
 */
function createSectionKeyer(root: ScanRoot): (element: Element) => string {
  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
  const sectionIds = new Map<Element, number>();
  return (element: Element): string => {
    const token = /(?:^|\s)(section-\S+)/i.exec(element.getAttribute('autocomplete') ?? '')?.[1];
    if (token) return `token:${token.toLowerCase()}`;
    const fieldset = element.closest('fieldset');
    if (fieldset) {
      if (!sectionIds.has(fieldset)) sectionIds.set(fieldset, sectionIds.size);
      return `fieldset:${sectionIds.get(fieldset)}`;
    }
    let preceding: Element | null = null;
    for (const heading of headings) {
      const position = heading.compareDocumentPosition(element);
      if (position & Node.DOCUMENT_POSITION_DISCONNECTED) continue;
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) preceding = heading;
    }
    if (preceding) {
      if (!sectionIds.has(preceding)) sectionIds.set(preceding, sectionIds.size);
      return `heading:${sectionIds.get(preceding)}`;
    }
    return '';
  };
}

/**
 * 看过同一节、说得清是哪一栏之后的置信度：与通用规则按标签认的那一步同一档。generic.json 把要看同一节的题面放在
 * 低于填写门槛的一步——规则不跟插件版本走，已经装在用户那里、不看同一节的内核读到它们只认不填。
 */
const CONTEXT_RESOLVED_CONFIDENCE = 0.75;

/** 改认的结果：换成哪个键、多大把握；`null` 是不认。 */
type ContextualKey = { readonly key: ApplyFieldKey; readonly confidence: number } | null;

/**
 * 要看同一节里还有什么才知道问的是什么的两种题面（2026-09-28 通用路，判据在 dict/fieldContext.ts）：
 *
 *  · 光秃秃的「Name」（德文 Name、法文 Nom、西文 Nombre……）规则认成全名。落在推荐人、紧急联系人、学校、雇主
 *    那一节里 → 不认（那是别人／那个机构的名字）；同一节里只有名那一栏 → 它是姓（「Vorname / Name」「Prénom / Nom」）；
 *    只有姓那一栏 → 它是名（「Nombre / Apellidos」）；名、姓都在 → 仍是全名，由后面「全名与名、姓并存」那一道丢掉；
 *    都没有 → 全名。
 *  · 光秃秃的「Job Title」：同一节里有现任公司那一栏才是现任职位，没有就不认（可能在问申请的岗位）。
 *
 * 认下来的都抬到能填的那一档（`CONTEXT_RESOLVED_CONFIDENCE`）：规则给的是低于门槛的一档，等的就是这一步。
 *
 * 看的是扫到的全部字段（不是计划里的条目）：名那一栏已经填着、没进计划，它仍说明这一节是「名 + 姓」的写法。
 */
function contextualKeys(
  form: ApplyFormDescriptor,
  sectionOf: (element: Element) => string,
): ReadonlyMap<ApplyFieldDescriptor, ContextualKey> {
  const adjusted = new Map<ApplyFieldDescriptor, ContextualKey>();
  // 只在通用路上改认：这几种键在通用路上来自只认标签的规则（generic.json）；厂商路上它们来自规则量过的锚点、
  // 行作用域与钩子，不在这里再判。
  if (form.vendor !== 'generic') return adjusted;
  // 认成学历／经历的栏（2026-09-28）：只在说到学历／经历的那一节里才认（dict/fieldContext.ts）。
  const captionOf = createSectionCaptioner(form.root);
  for (const field of form.fields) {
    if (field.key === null || !isCollectionFieldRole(field.key)) continue;
    if (!sectionMentionsCollection(captionOf(field.element), field.key)) adjusted.set(field, null);
  }
  const candidates = form.fields.filter((field) =>
    (field.key === 'fullName' && isBareNameLabel(field.label)) ||
    (field.key === 'currentJobTitle' && isBareJobTitleLabel(field.label)));
  if (candidates.length === 0) return adjusted;
  const keysBySection = new Map<string, Set<string>>();
  for (const field of form.fields) {
    if (field.key === null || candidates.includes(field)) continue;
    const section = sectionOf(field.element);
    const keys = keysBySection.get(section) ?? new Set<string>();
    keys.add(field.key);
    keysBySection.set(section, keys);
  }
  const resolved = (field: ApplyFieldDescriptor, key: ApplyFieldKey): ContextualKey =>
    ({ key, confidence: Math.max(field.confidence, CONTEXT_RESOLVED_CONFIDENCE) });
  for (const field of candidates) {
    const keys = keysBySection.get(sectionOf(field.element)) ?? new Set<string>();
    if (field.key === 'currentJobTitle') {
      adjusted.set(field, keys.has('currentCompany') ? resolved(field, 'currentJobTitle') : null);
      continue;
    }
    if (describesAnotherParty(captionOf(field.element))) {
      adjusted.set(field, null);
      continue;
    }
    const first = keys.has('firstName');
    const last = keys.has('lastName');
    adjusted.set(field, resolved(field, first && !last ? 'lastName' : last && !first ? 'firstName' : 'fullName'));
  }
  return adjusted;
}

/** 扁平档案没有现任公司／职位时，工作经历里标着「现在」的那一段（恰好一段才算）。 */
function currentExperience(collections: ApplyProfileCollections | undefined) {
  const current = (collections?.experiences ?? []).filter((experience) => experience.isCurrent === true);
  return current.length === 1 ? current[0]! : null;
}

/**
 * 写进电话栏的值。
 *
 * 表自己有国际区号控件时，整串 `+1 415 555 0142` 是**无效输入**——2026-09-15
 * 在 nvidia.wd5.myworkdayjobs.com 实测，宿主回 `Enter a valid format for Phone
 * Number`，号码看着填进去了，Save and Continue 却过不去。这不是 Workday 的
 * 特例：凡是把区号拆成独立控件的表单（intl-tel-input、Workday、多数 HRIS）
 * 都只收国内号段。
 *
 * 拆不出来就原样返回：`nationalPhoneNumber` 只在值自己声明了区号（`+` / `00`）
 * 且区号可辨时才给答案，档案里存的本来就是国内号段时一个字都不动。
 */
function phoneValueFor(key: ApplyEntryKey, value: string, formOwnsCallingCode: boolean): string {
  if (key !== 'phone' || !formOwnsCallingCode) return value;
  return nationalPhoneNumber(value) ?? value;
}

/**
 * 蜜罐几何层该量**哪个**元素。
 *
 * 默认就是控件自己。唯一的例外是规则量过并声明了 `activationSelector` 的
 * 托管下拉：那一族里被扫到的 input 只是部件的值镜像，人操作的是同一个值容器
 * 里那个可见的触发控件（Workday 的 `button[aria-haspopup="listbox"]` 旁边挂
 * 一个 0×0 的 input，2026-09-15 实测 344×40 对 0×0）。量镜像等于把一个合法
 * 必填控件判成陷阱；量触发器才是「人看不看得见这一栏」的诚实答案。
 *
 * 与 `file` 那条豁免同形：那一档不是不判，而是判据换成文件写入器的触发器检查。
 * 这里也不是不判——触发器隐藏了照样命中，文案层与身份层两道防线一并保留。
 * 没有规则声明就退回控件自己，`phone-sms-opt-in` 这类 0×0 陷阱照旧 fail closed。
 */
function honeypotGeometryTarget(field: ApplyFieldDescriptor): Element {
  // 分段日期的一段（2026-09-24，Workday 的 MM/YYYY）：真输入框 1px 宽、`scale(0.01)`，量出来 0.09×0.23，
  // 与 CSS 藏起来的陷阱逐条一致；人点的、看得见的是它的父节点那一段（17×28）。只在规则把这一格认成
  // 日期的年／月角色时换着量——别的 spinbutton 照旧量它自己。
  if (field.key !== null && isDatePartRole(field.key) && dateSegmentGroup(field.element) !== null) {
    return field.element.parentElement ?? field.element;
  }
  if (field.kind !== 'combobox' || field.listbox?.activationSelector === undefined) return field.element;
  const { valueContainerSelector, activationSelector } = field.listbox;
  try {
    return field.element.closest(valueContainerSelector)?.querySelector(activationSelector) ?? field.element;
  } catch {
    // 选择器漂了就当没声明：量控件自己，退回三道防线的原样。
    return field.element;
  }
}

/**
 * 蜜罐几何层量出来的这一栏（2026-10-04 加：样式藏起来的原生单选、复选改量它的标签）。
 *
 * 先量 `honeypotGeometryTarget`。原生单选／复选自己量出来像陷阱（0×0、推到视口外、裁成一点）、而它有一个
 * `<label>`（包着它的，或 `for=` 指着它的）时，改量那个标签：自己画圆圈、方框的表单（Jobvite 的是非题：
 * `label > i[role=radio] + input[type=radio]`，radio 被样式藏成 0×0）里，人看得见、点得到的就是标签，点标签
 * 就是点它。只量 radio 自己会把一整道必填题判成蜜罐——蜜罐从不进单子，浮层上一个字都没有（bench-1003）。
 *
 * 真的蜜罐连标签也看不见，量标签照样拦得住；没有标签的（Workday 的 `phone-sms-opt-in`）照旧量它自己、照旧
 * fail closed。代理控件（`control: 'proxy'`）量的本来就是人点的那一个，不换。
 */
function honeypotGeometryOf(
  field: ApplyFieldDescriptor,
  readGeometry: (element: Element) => HoneypotGeometry,
): HoneypotGeometry {
  const own = readGeometry(honeypotGeometryTarget(field));
  if (field.kind !== 'choice' || field.choice.control === 'proxy' || !isHoneypotGeometry(own)) return own;
  const label = nativeChoiceLabelOf(field.element);
  return label === null ? own : readGeometry(label);
}

/** 原生单选／复选的标签：`input.labels` 的第一个（包着它的或 `for=` 指着它的），没有就是包着它的那个 `<label>`。 */
function nativeChoiceLabelOf(input: Element): Element | null {
  const labels = (input as Partial<HTMLInputElement>).labels;
  const first = labels !== null && labels !== undefined && labels.length > 0 ? labels[0] : undefined;
  return first ?? input.closest('label');
}

/**
 * 生成计划。每个字段要么进 `entries`（会填），要么进 `skipped` 并带一个
 * 稳定错误码（通用铁律 5：UI 永远不解析自由文本）。
 */
/**
 * 默认几何读取：与 `write/setFile.ts` 的可见性判定同源同姿势。
 * 一次性把整表读完（见 buildApplyPlan 里的标定），不与写入交错——
 * 交错读写会反复触发强制同步布局。
 */
/** 表上认得出的一个求职信栏（宿主控件，只在本地）。 */
export interface CoverLetterTarget {
  readonly element: Element;
  /** `text`：文字框或规则证明过的纯文本编辑器，要正文；`file`：上传栏，要 PDF。 */
  readonly kind: 'text' | 'file';
  readonly required: boolean;
}

/**
 * 这张表上认得出的求职信栏（2026-09-27 负责人：必填、可选都附）。与 `buildApplyPlan` 的求职信分支同源：文字框按
 * `isCoverLetterField`（标签、稳定钩子、aria-label、占位符），纯文本编辑器按规则的 cover-letter 证明，上传栏按
 * `isCoverLetterFileField` ∧ `hasApprovedCoverLetterFileIdentity`。调用方据此决定要不要去要一封、要正文还是 PDF；
 * 写不写仍由计划与 runner 各自再判。
 */
export function coverLetterTargets(form: ApplyFormDescriptor): readonly CoverLetterTarget[] {
  const targets: CoverLetterTarget[] = [];
  for (const field of form.fields) {
    const element = field.element;
    const label = field.label || field.key || '';
    const identities = [
      element.getAttribute('name'),
      element.getAttribute('id'),
      element.getAttribute('data-automation-id'),
      element.getAttribute('data-ui'),
      element.getAttribute('data-qa'),
      element.getAttribute('data-testid'),
    ];
    if (field.kind === 'file') {
      if (isCoverLetterFileField(label, identities) && hasApprovedCoverLetterFileIdentity(field.element, form.root)) {
        targets.push({ element, kind: 'file', required: field.required });
      }
      continue;
    }
    const text = field.kind === 'textarea'
      ? isCoverLetterField(label, [...identities, element.getAttribute('aria-label'), element.getAttribute('placeholder')])
      : field.kind === 'richtext' && field.plainTextContenteditableAttestation?.purpose === 'cover-letter';
    if (text) targets.push({ element, kind: 'text', required: field.required });
  }
  return targets;
}

/** 公民身份／绿卡题留给本人；已审阅或记住的答案也不构成自动填写授权。 */
export function isCitizenshipQuestion(label: string): boolean {
  return /\bcitizen(?:s|ship)?\b|\bgreen[ -]?card\b|\b(?:lawful[ -]+|legal[ -]+)?permanent[ -]+(?:resident(?:s)?|residency)\b|公民|绿卡|永久居民/iu.test(label);
}

/** 产品 11 §3.3 明确留给本人的身份题；不从工作授权记录推 U.S. person／出口管制身份。 */
export function isManualIdentityQuestion(label: string): boolean {
  return isCitizenshipQuestion(label)
    || /\bu\.?\s*s\.?\s*persons?\b|\bexport[ -]+controls?\b[^?.]{0,80}\b(?:status|eligib(?:le|ility)|identity|person)\b|\b(?:status|eligib(?:le|ility)|identity|person)\b[^?.]{0,80}\bexport[ -]+controls?\b|出口管制身份/iu.test(label);
}

export function buildApplyPlan(
  form: ApplyFormDescriptor,
  profile: ApplyProfileDraft,
  options: BuildPlanOptions = {},
): ApplyPlan {
  const fillEmptyOnly = options.fillEmptyOnly !== false;
  const resolved = deriveProfile(profile, options.suppressedKeys);
  // 现任公司、现任职位（2026-09-28）：扁平档案里没有、用户也没关掉时，按工作经历里标着「现在」的那一段。
  // 没有一段是现在的（或好几段都是）就不推——不拿以前的公司充当现任。
  const current = currentExperience(options.collections);
  if (current !== null) {
    if (!resolved.currentCompany && current.company && !isSuppressed(options.suppressedKeys, 'currentCompany')) {
      resolved.currentCompany = current.company;
    }
    if (!resolved.currentJobTitle && current.title && !isSuppressed(options.suppressedKeys, 'currentJobTitle')) {
      resolved.currentJobTitle = current.title;
    }
  }
  // 「是否年满 18 岁」（2026-09-24，dict/historyAnswers.ts）：档案里没有明确的值、用户也没关掉这一类时，
  // 有教育或工作经历就当作年满 18。只给选项控件上的年龄题用（见循环里的 `values`），以及「年满 18 且有权
  // 工作」那道合起来的题（`ageAndWorkAuthorizationAnswer`）。
  const adultByHistory = !resolved.over18 && !isSuppressed(options.suppressedKeys, 'over18') &&
    adultFromHistory(options.collections);
  const formOwnsCallingCode = hasOwnCallingCodeControl(form);

  // 蜜罐几何层的**环境标定**。
  //
  // `isHoneypotGeometry` 的第一条判据是 width<=1||height<=1，而无布局环境
  // （happy-dom / jsdom / display:none 的祖先下）对每个元素都返回 0×0。不标定
  // 就一律生效 = 整表所有字段被判成陷阱，一个都填不了，理由还是「蜜罐」——
  // 比不接这道防线糟得多。
  //
  // 蜜罐几何层。只有调用方注入了测量手段才启用——见 readGeometry 的说明。
  //
  // 安全网：即使注入了，**整表每一个控件都退化**（width<=1 或 height<=1）时
  // 仍然关闭。那说明环境根本不布局，或者整个表单在 display:none 的祖先下；
  // 此时逐个判据会把每个合法字段都判成陷阱——一个都填不了，理由还是「蜜罐」，
  // 比不接这道防线糟得多。宁可漏判退回两道防线，不可误杀合法必填项。
  //
  // 测量一次性做完，不与后面的写入交错：交错读写会反复触发强制同步布局。
  const geometries = new Map<Element, HoneypotGeometry>();
  // 通用路（2026-09-28）：藏起来的原生下拉 → 替它说话的那个 ARIA 触发器（write/ariaComboboxGeneric.ts 的
  // selectProxyOf）。下拉自己量出来是 0×0、而旁边恰好有这样一个触发器时，蜜罐几何量那个触发器（人看得见、点得到的
  // 是它，与规则声明的 activationSelector 同一个道理），条目带上它，runner 点它、在它自己的面板里选。
  const selectProxies = new Map<Element, HTMLElement>();
  let geometryActive = false;
  if (options.readGeometry) {
    for (const field of form.fields) {
      const own = honeypotGeometryOf(field, options.readGeometry);
      const proxy = form.vendor === 'generic' && field.kind === 'select' && (own.width <= 1 || own.height <= 1)
        ? selectProxyOf(field.element, form.root)
        : null;
      if (proxy !== null) selectProxies.set(field.element, proxy);
      geometries.set(field.element, proxy === null ? own : options.readGeometry(proxy));
    }
    geometryActive = [...geometries.values()].some(
      (geometry) => geometry.width > 1 && geometry.height > 1,
    );
  }
  const entries: ApplyPlanEntry[] = [];
  const skipped: ApplyPlan['skipped'] = [];
  const sectionKeyFor = createSectionKeyer(form.root);
  const contextKeys = contextualKeys(form, sectionKeyFor);

  for (const [order, scanned] of form.fields.entries()) {
    // 看同一节才知道问的是什么的那几种题面，键与把握在这里改认（见 contextualKeys）；其余原样。
    const adjusted = contextKeys.get(scanned);
    const field: ApplyFieldDescriptor = adjusted === undefined
      ? scanned
      : { ...scanned, key: adjusted?.key ?? null, confidence: adjusted?.confidence ?? 0 } as ApplyFieldDescriptor;
    const label = field.label || field.key || '';

    // 守卫先于一切匹配。放在引擎而不是各个 adapter 里，是因为它必须天然覆盖
    // 现有与未来的每一个厂商——写在 adapter 里就要改 N 处，漏一处就破一处。
    //
    // ⚠️ 这段曾经不存在：`dict/guards.ts` 写好了检测函数、单测全绿，却**从未
    // 被任何调用方 import**（构建产物里 `beecatcher` 出现 0 次），于是防线整体
    // 是死代码。评审端到端实测：Workday 的 beecatcher 以 confidence 0.75 命中
    // portfolioUrl 被真的写入，UI 还显示"已填"（2026-08-01）。
    const element = field.element;
    const identities = [
      element.getAttribute('name'),
      element.getAttribute('id'),
      element.getAttribute('data-automation-id'),
      element.getAttribute('data-ui'),
      element.getAttribute('data-qa'),
      // 2026-08-23 加：Rippling 的 name 为空、id 是位置序号 `field-4`，
      // 唯一语义化的属性就是 `data-testid="input-resume"`。少了这一条，
      // 那一家的简历上传**永不触发且完全静默**——与 2026-08-01 Greenhouse
      // 那次同一形状（见 dict/guards.ts 的 `isResumeFileField` 头注）。
      element.getAttribute('data-testid'),
    ];
    if (
      isHoneypot({
        text: [
          label,
          element.getAttribute('placeholder'),
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ]
          .filter((value): value is string => Boolean(value))
          .join(' '),
        identities,
        // 第三道：几何。纯 CSS 藏起来的陷阱（1×1 / clip:rect(1px…) /
        // clip-path:inset(50%) / 零字号）文案与身份两层都干净，只有这一层拦得住。
        // 仅在环境会布局时启用，见上面的标定。
        // 原生文件控件通常本身就是 1×1、被 clip 掉，藏在一个可见的 "Attach" 按钮后面
        // （Greenhouse 2026-09-10 实测）；它的可见性由文件写入器的触发器检查判定，不看自身几何。
        ...(geometryActive && field.kind !== 'file' ? { geometry: geometries.get(element) } : {}),
      })
    ) {
      skipped.push({ label, reason: 'HONEYPOT', required: field.required, key: field.key, element, order });
      continue;
    }
    if (isManualIdentityQuestion(`${label} ${questionContextOf(element)}`)) {
      skipped.push({ label, reason: 'MANUAL_ONLY', required: field.required, key: field.key, element, order });
      continue;
    }
    // 代填条款、声明与签名（2026-09-23；负责人 2026-09-22 夜的决定，dict/signOnBehalf.ts）。
    //
    // 排在「只能本人填写」之前：签名栏未必命中那一层的判据——「Type your full name as your
    // signature」不带 electronic，从前会被 Lever／通用规则认成 fullName、当成姓名直接写上。
    // 这里先把三类认出来：能力位（运行时包放行 ∧ 用户在资料页单独同意过，由调用方合成）开着才排进
    // 计划；关着、或值给不出来（没有姓名、没有当天日期），一律 MANUAL_ONLY，与从前逐字相同。
    // ARIA 代理题（2026-09-23：Ashby 的是非按钮、Workable 的 role=radio / role=checkbox）上的条款同意、
    // 属实声明一律交还本人。第三刀（2026-09-24）的六类同意例外：代理题的点击路径从这一刀起带着代填
    // 标记与题干元素，点击策略在每一下之前把题干和选项各认一遍（`signOnBehalfProxyAllowed`）。
    // 认得出却不代填，就是 MANUAL_ONLY。
    // 第五刀（2026-09-28）：能力位之外还要这一类在这一轮获准的类别里（`signOnBehalfKinds`：同意了当前版本的代填授权
    // 覆盖的同意类，加上资料里答过的「能不能联系雇主」）。能不能联系雇主按他的回答答，没答就认不出、照旧交还本人。
    const signing = signOnBehalfTargetOf(field, label, options.employerContact);
    if (signing !== null) {
      if (options.capabilities?.['sign-on-behalf'] === true && signOnBehalfKindAllowed(options, signing.kind) &&
        signOnBehalfProxyAllowed(field, signing.kind) &&
        planSignOnBehalf(entries, skipped, field, signing, label, resolved, order, fillEmptyOnly, options.signingDate)) {
        continue;
      }
      skipped.push({ label, reason: 'MANUAL_ONLY', required: field.required, key: field.key, element, order });
      continue;
    }
    // 铁律 5 的四类：EEO 自我认同 / 法律声明勾选 / 密码 / 验证码。
    // 排在蜜罐之后（蜜罐更具体且"填了作废整份申请"更急），在其余守卫之前。
    // 2026-08-18 之前这四类在写入链上**一道守卫都没有**——密码不被填只是因为
    // TEXTUAL_INPUT_TYPES 白名单碰巧没有 'password'，没有任何测试写着"不许填"。
    // 「I identify as」「How do you identify?」（2026-09-28 Zalando，必填）：题面没说是哪一档，选项全是性别的说法
    // （男、女两项都在）才按性别那一档读；判读与写入仍走下面同一道自我认同的闸（能力位、档案有值、恰好一项）。
    const selfIdentificationText = isOptionControl(field) && field.kind !== 'combobox' && isBareIdentityPrompt(label) &&
      isGenderAnswerSet(optionTexts(field))
      ? `Gender: ${label}`
      : label;
    if (
      isManualOnlyControl({
        text: selfIdentificationText,
        // 只看文案挡不住「label 写 Email、控件是 password」这种形状。
        // 见 `isManualOnlyControl` 头注（Yiwen 审 PR #20 的探针）。
        inputType: field.element.getAttribute('type'),
        autocomplete: field.element.getAttribute('autocomplete'),
      })
    ) {
      // 乙档的那一支：EEO 自我认同**问的就是用户自己**，答案是他在档案里亲手填的
      // 那个值。能力位打开、档案里有值、且页面上恰好有一个选项对得上时，**直接写**
      // （2026-09-21 起）：他在门户里填下并保存的那一下就是同意，不再在面板上要他
      // 点第二次头——从前这里产出 PREFILLED_NEEDS_CONFIRMATION 等放行，实测用户把
      // 「填完才告诉我哪些要确认」读成没填。四道闸一道没松：能力位、法定四档、
      // 档案有值、恰好一个选项对得上，缺一道仍是 MANUAL_ONLY。
      const prefill = selfIdentificationPrefill(field, selfIdentificationText, resolved, options);
      if (prefill !== null) {
        const outcome = pushOptionAnswer(entries, skipped, field, prefill.key, label, prefill.answer, order, fillEmptyOnly);
        if (outcome) continue;
      }
      skipped.push({ label, reason: 'MANUAL_ONLY', required: field.required, key: field.key, element, order });
      continue;
    }
    // 推荐人 / 紧急联系人 / 配偶：标签匹配的无锚点正则（/linkedin/i 等）会把
    // 申请人本人的资料写进去，并显示成绿色"已填"——recruiter 收到一份推荐人
    // 等于本人的申请，而用户复核时最容易略过绿色条目。
    // 能力位打开 = 调用方声明自己有他人数据源，这一栏照常进计划（其余守卫不放松）。
    // 不给 = 与从前逐字相同。
    if (isReferralField(label)) {
      // 恰好一条推荐到这家的记录是用户自己存的：直接写姓名（2026-09-21 起不再等确认）。
      const referral = referralPrefill(field, label, options);
      if (referral !== null && field.kind === 'text') {
        if (fillEmptyOnly && readValue(field.element).trim() !== '') {
          skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: 'referralName', element, order });
          continue;
        }
        entries.push(planEntry(field, 'referralName', label, referral.name, order, 1));
        continue;
      }
      skipped.push({ label, reason: 'OTHER_PERSON', required: field.required, key: field.key, element, order });
      continue;
    }
    if (isOtherPersonField(label) && options.capabilities?.['set-other-person'] !== true) {
      skipped.push({ label, reason: 'OTHER_PERSON', required: field.required, key: field.key, element, order });
      continue;
    }
    // 「你在这家公司工作过吗／现在在这里吗」（2026-09-24，负责人：跟 Jobright 一样；dict/historyAnswers.ts）：
    // 经历里有这家就答是、没有就答否，只在选项控件上、页面上恰好一项对得上时写。排在他人守卫之后：
    // 「亲属在这里工作吗」先被那一道接走。答不准（岗位公司不知道、经历没交来、雇主名只是部分对得上）
    // 就一个字不改地走原路——下拉照旧 USER_ONLY、单选照旧 CHOICE_NO_DATA。
    if (isOptionControl(field)) {
      const employment = hiringCompanyEmployment(label, options.jobCompany, options.collections);
      const answer = employment === null
        ? null
        : optionAnswer(field, employment.answer) ?? neverEmployedAnswer(field, employment.basis, options.jobCompany!);
      const before = entries.length;
      if (employment !== null && answer !== null &&
        pushOptionAnswer(entries, skipped, field, 'previouslyEmployedHere', label, answer, order, fillEmptyOnly)) {
        const entry = entries[before];
        if (entry !== undefined) entry.historyBasis = employment.basis;
        continue;
      }
    }
    // 「Are you a transitioning service member?」（2026-09-24，负责人：跟 Jobright 一样；dict/historyAnswers.ts）：
    // 题面由规则认（键 transitioningServiceMember），答案按工作经历推——有工作经历、一段都不像军队服役就答 No，只在
    // 选项控件上、页面上恰好一项对得上时写。答不了（有一段像军职、没有工作经历、集合没交来、题面不是那一句本身、
    // 置信度不够）就交还本人：单选 CHOICE_NO_DATA，下拉与文本框 USER_ONLY。这个键不是扁平档案键，不往下走。
    if (field.key === 'transitioningServiceMember') {
      const service = isOptionControl(field) && field.confidence >= MIN_APPLY_CONFIDENCE
        ? transitioningServiceMemberAnswer(label, options.collections)
        : null;
      const answer = service === null || !isOptionControl(field) ? null : optionAnswer(field, service.answer);
      const before = entries.length;
      if (service !== null && answer !== null &&
        pushOptionAnswer(entries, skipped, field, 'transitioningServiceMember', label, answer, order, fillEmptyOnly)) {
        const entry = entries[before];
        if (entry !== undefined) entry.historyBasis = service.basis;
        continue;
      }
      skipped.push({ label, reason: field.kind === 'choice' ? 'CHOICE_NO_DATA' : 'USER_ONLY', required: field.required, key: field.key, element, order });
      continue;
    }
    // 按资料推出来的几类（2026-10-04，10-03 批测里「AI 在资料里找不到依据」那一批）：办公方式、语言、工作年限、
    // 现在在读吗、服过兵役吗。题面由内核按整句认（dict/workArrangement.ts、languages.ts、experienceYears.ts、
    // historyAnswers.ts），答案只从他的资料推：可接受的办公方式（与住处、搬迁意愿）、确认过的语言与水平、带日期的
    // 工作经历、教育经历。答不准就一个字不改地走原路（照旧可以交给 AI 或本人）。排在他人、同意、自我认同几道守卫之后，
    // 工作授权、搬迁那几道交还之前——那几类题这几个判读一律不认。条目带依据，浮层据此写明答案是怎么来的。
    const derived = derivedProfileAnswer(field, label, resolved, options);
    if (derived !== null) {
      const before = entries.length;
      if (pushDerivedAnswer(entries, skipped, field, derived, label, order, fillEmptyOnly)) {
        const entry = entries[before];
        if (entry !== undefined && entry.key === derived.key) entry.historyBasis = derived.basis;
        continue;
      }
    }
    // 年龄与随岗位而定的事问在同一句里（2026-09-24，dict/ageQuestion.ts）：从前只凭 over18 一半就答了，
    // 没有 over18 时又只凭工作授权一半答。现在只答「年满 18 且有权在 X 工作」那一种，而且两半都得有依据：
    // 都是「是」才答是；年龄明确「否」、或那国的授权记录明确「否」就答否；其余交还（JOB_DEPENDENT）。
    // 工作授权那一半必须来自该国有效记录，别国的记录不能补出答案。
    // 排在搬迁与工作授权之前：「年满 18 且愿意搬迁」同样不许只凭其中一半作答。只管认成 over18 的与没认出键的：
    // 规则认到别的键（期望薪资里写着「minimum 18」之类）照旧按那个键走。
    if ((field.key === null || field.key === 'over18') && mixesAgeWithJobQuestion(label)) {
      const combined = ageAndWorkAuthorizationAnswer(label, resolved.over18, adultByHistory, options);
      const answer = combined === null || !isOptionControl(field) ? null : optionAnswer(field, combined.answer);
      const before = entries.length;
      if (combined !== null && answer !== null &&
        pushOptionAnswer(entries, skipped, field, combined.key, label, answer, order, fillEmptyOnly, combined.basis)) {
        const entry = entries[before];
        if (entry !== undefined && combined.fromHistory) entry.historyBasis = 'ADULT_FROM_HISTORY';
        continue;
      }
      skipped.push({ label, reason: 'JOB_DEPENDENT', required: field.required, key: field.key, element, order });
      continue;
    }
    // 工作授权 / 签证担保 / 期望薪资 / 到岗时间：答案是 f(候选人 × 岗位)。
    // **必须在 LOW_CONFIDENCE 之前**——否则它们会被"我们没认出来"吃掉，而这两件事
    // 对用户的含义完全相反：一个是"再等等我们会支持"，另一个是"只能你自己答"。
    //
    // ⚠️ 这条守卫此前是死代码：JOB_DEPENDENT 的枚举、错误文案、中英两套 i18n 三处
    // 登记齐全，引擎里一次都没调用过（Codex 的立项决策单 §59 指出，实测属实）。
    // 这是本项目第三次同一形状的问题（蜜罐守卫、推荐人守卫、这条），所以
    // tests/apply-job-dependent.test.ts 用"守卫删掉必须变红"的方式锁死接线本身。
    // 期望薪资 / 到岗时间 / 搬迁意愿这三类从 2026-09-21 起在档案里有自己的键
    // （P1-5）：规则把这一栏认到了键、档案里又有值，就按普通字段填——用户在档案里
    // 写下的期望薪资就是他要填的期望薪资。认不到键或没有值的，仍走下面那道交还。
    // 「现在人在 X，或者愿意搬去 X 吗」必须排在 JOB_DEPENDENT 那道交还**之前**：
    // `isJobDependentField` 把带「relocate」的题一律算成随岗位而定，于是这道题整轮
    // 落「取决于这个岗位，由你回答」（2026-09-22 实测：Discord 每一页都有，八页全落）。
    // 而它其实两半都在档案里——住在哪（city / addressRegion）说得出前半句，
    // 「愿意搬去哪几座城市」（P1-5 起的 openToRelocation*）说得出后半句。
    // 判据窄在 dict/relocation.ts：只答得出「是」，掺了工作许可、搬家费用或
    // 「什么时候能搬」的都不归这里管。
    const relocation = relocationPrefill(field, label, resolved, options.jobLocation);
    if (relocation !== null) {
      const outcome = pushOptionAnswer(entries, skipped, field, 'relocation', label, relocation, order, fillEmptyOnly);
      if (outcome) continue;
    }
    // over18 例外（2026-09-24）：问号前那一句是年龄题才按年龄答（反着问的、推出来的都在后面按题面判）；
    // 问的是工作授权、只在说明里提到 18 岁的，照旧走下面那道交还与授权记录。
    const keyedFlatValue = field.key !== null &&
      !isCollectionFieldRole(field.key) &&
      field.confidence >= MIN_APPLY_CONFIDENCE &&
      (field.key === 'over18' ? asksAge(label) : Boolean(resolved[field.key as ApplyFieldKey]));
    if (isJobDependentField(label) && !keyedFlatValue) {
      // 乙档的另一支：工作授权／担保。它与 EEO 的差别是**答案随岗位所在国家变**——
      // 所以先得说得出是哪一国（题目点名、或下面的按岗位地点推断），再看用户在那一国有没有记录。
      // 点名了国家、用户有那条记录 → 直接写（那条记录是他自己填的）。
      //
      // 题目没点名、按岗位地点**推断**出国家的（P1-7）：2026-09-21 定的是只预填、等用户点头；
      // 2026-09-23 负责人改为同样直接写——「Will you now or in the future require sponsorship
      // (e.g., H-1B)」几乎每家都问、几乎都不点名国家，每次都要用户多点一下「回填」。前提没变：调用方
      // 从申请卡片**确定性地**解出恰好一个国家才传（Remote / EMEA 解不出就不传）、问的不是「你现在住的
      // 国家」。条目带上推断的国家，浮层写明依据。
      //
      // 说得出是哪一国、用户在那一国没有记录：不带答案、也不带预填，一律交还本人。
      // 即使有别国记录也不能替代；这一行带上缺记录的国家，让浮层说清楚缺的是什么。
      const verdict = workAuthorizationPrefill(field, label, options);
      const authorized = verdict?.kind === 'ANSWER' ? verdict : null;
      if (authorized !== null) {
        const outcome = pushOptionAnswer(
          entries, skipped, field, authorized.key, label, authorized.answer, order, fillEmptyOnly, authorized.basis,
        );
        if (outcome) continue;
      }
      skipped.push({
        label,
        reason: authorized === null ? 'JOB_DEPENDENT' : 'PREFILLED_NEEDS_CONFIRMATION',
        required: field.required,
        key: field.key,
        ...(authorized === null ? {} : { prefill: authorized.answer.value }),
        ...(authorized?.basis.inferredRegionCode === undefined ? {} : { inferredRegionCode: authorized.basis.inferredRegionCode }),
        ...(verdict?.kind === 'NO_RECORD' ? { regionWithoutRecord: verdict.regionCode } : {}),
        element,
        order,
      });
      continue;
    }
    // 「你现在人在 X 吗」：答案就在档案的 addressCountry 里。
    //
    // 放在这里而不是更早：前面几道守卫各自管的是「只能你本人答」「涉及他人」
    // 「随岗位变」，这一类都不是——它问的是一个我们已经照抄进 Country 那一栏的
    // 事实。2026-09-18 的 100 页批测里它被判成 LOW_CONFIDENCE（面板说「没把握，
    // 没敢填」），而那句话是冤枉的：不是没把握，是从来没人去看档案。
    //
    // **只在答得上来的时候拦截**，答不上来就一个字不改地走原路。判据窄在
    // dict/residence.ts：掺了搬迁或意愿的不答，工作许可与担保不归这里管，
    // 题目必须点名国家、且点名的必须是档案里那一个——所以只答得出「是」，
    // 答不出「否」。宁可少填一栏，也不替他否认一件我们并不知道的事。
    const residence = residencePrefill(field, label, resolved);
    if (residence !== null) {
      // 答案就是他档案里的国家：直接写（2026-09-21 起与 EEO 同一档，不再等确认）。
      const outcome = pushOptionAnswer(entries, skipped, field, 'residence', label, residence, order, fillEmptyOnly);
      if (outcome) continue;
    }
    // 守卫全部走完之后，才轮到"这类控件我们填不了"。
    //
    // ⚠️ 顺序本身是安全属性（2026-08-15 修）：这个分支原先排在三道守卫**之前**，
    // 而单选/复选今天一律落 unsupported——于是 choice 字段从不经过任何一道防线。
    // 今天无害（一个都不写），但接上 choice 写入的那一刻就是现成的漏洞：蜜罐
    // checkbox、推荐人 radio 会被直接写进宿主表单。本项目同一形状的问题已经
    // 犯过三次（蜜罐守卫、推荐人守卫、JOB_DEPENDENT 都曾是没有调用方的死代码，
    // 其中蜜罐那次实测后果是 Workday 的 beecatcher 以 0.75 置信度命中
    // portfolioUrl 被真写入、UI 还显示"已填"）。
    // tests/apply-guards-before-unsupported.redgreen.test.ts 锁死这个顺序。
    // 认成 over18 的题（2026-09-24，dict/ageQuestion.ts）：按题面判问的是哪一边——年满那一边照档案值答，
    // 未满那一边（under 18、a minor……）答它的反面；说不清就不答（LOW_CONFIDENCE：这道题我们没读懂）。
    // 档案里没有明确的值时，选项控件上用按学历／工作经历推出来的「年满 18」；文本框不推——没有「恰好一项」可对。
    // 问法定工作年龄的（WORKING_AGE）：年满 18 就答「是」；档案明确未满 18 答不了——很多地方 14–16 岁就能工作，到没到
    // 法定工作年龄随岗位所在地而定，交还用户（JOB_DEPENDENT）。
    const age = field.key === 'over18' ? ageQuestion(label) : undefined;
    const minorAtWorkingAge = age === 'WORKING_AGE' && resolved.over18 === 'false';
    if ((age === null || minorAtWorkingAge) && field.kind !== 'unsupported') {
      skipped.push({
        label, reason: minorAtWorkingAge ? 'JOB_DEPENDENT' : 'LOW_CONFIDENCE', required: field.required, key: field.key, element, order,
      });
      continue;
    }
    const values = age === undefined || age === null
      ? resolved
      : withAgeAnswer(resolved, age, adultByHistory && isOptionControl(field));
    if (field.kind === 'unsupported') {
      // 单选/复选要跟"这类控件我们填不了"分开说：前者的下一步是"你自己选一下"，
      // 后者的下一步是"等我们支持"。混在一起，用户和下一个接手的人都会被误导。
      skipped.push({
        label,
        reason: field.unsupportedReason === 'CHOICE_NO_DATA' ? 'CHOICE_NO_DATA' : 'UNSUPPORTED_CONTROL',
        required: field.required,
        key: field.key,
        element,
        order,
      });
      continue;
    }

    // 单选/复选：规则把它认到了扁平档案键、档案里又有值（是否年满 18、是否愿意搬迁、
    // 办公模式、薪资周期……）就按档案写——把码展开成人读写法逐个去撞选项文字，每个码
    // 恰好命中一项才算数（P1-5 之前这一类一律 CHOICE_NO_DATA，用户在面板里再答一遍他
    // 档案里已经答过的题）。认不到键、没有值、或页面上没有对得上的选项，仍留给用户在
    // 审阅面板里答（buildAnswerPlan）。
    if (field.kind === 'choice') {
      // 在职与否（2026-09-24，Workday 行内的「I currently work here」）：一个勾选框，答案是这一段经历
      // 是不是「至今」。在职就勾上它（宿主随即收起 To，投影层也不给在职那一段结束日期）；不在职就不碰——
      // 没勾本来就是对的，已经勾上的也不替他取消（不覆盖页面上已有的状态，与 fillEmptyOnly 同一条）。
      if (field.key === 'experience.isCurrent') {
        planCurrentRowCheckbox(entries, skipped, field, label, order, form.root, options.collections);
        continue;
      }
      const lines = field.key !== null &&
        !isCollectionFieldRole(field.key) &&
        field.confidence >= MIN_APPLY_CONFIDENCE
        ? keyedChoiceLines(field, field.key as ApplyFieldKey, values)
        : null;
      if (lines === null) {
        skipped.push({ label, reason: 'CHOICE_NO_DATA', required: field.required, key: field.key, element, order });
        continue;
      }
      if (fillEmptyOnly && choiceAlreadyAnswered(field)) {
        skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: field.key, element, order });
        continue;
      }
      entries.push(planEntry(field, field.key as ApplyFieldKey, label, lines.join('\n'), order));
      continue;
    }

    // 简历文件。**正向白名单**：一张表上常常还有求职信、成绩单、作品集，
    // 把简历挂到"成绩单"那一栏比不挂糟得多——recruiter 看到一份明显不对的附件，
    // 而用户以为自己传对了。认不出就当普通不支持控件处理。
    if (field.kind === 'file') {
      // 求职信上传栏（2026-09-27）：与简历各走各的身份判据（dict/guards 的 isCoverLetterFileField 与
      // write/setFile 的 hasApprovedCoverLetterFileIdentity，runner 写前同源再核）。认出来就记成 coverLetter——
      // 就算这一次没有信，调用方也要知道这一栏是求职信，好说清楚为什么（还在写、岗位不在岗位库、额度用完……）。
      if (isCoverLetterFileField(label, identities) && hasApprovedCoverLetterFileIdentity(field.element, form.root)) {
        if (!options.coverLetterFileName) {
          skipped.push({ label, reason: 'UNSUPPORTED_CONTROL', required: field.required, key: 'coverLetter', element, order });
          continue;
        }
        if (!options.coverLetterTargetVerified) {
          skipped.push({ label, reason: 'HOST_UNCONFIRMED', required: field.required, key: 'coverLetter', element, order });
          continue;
        }
        // 文件没有撤销可言（setFile 头注）：用户已经挂了自己的，无论开关都不碰。
        if ((field.element.files?.length ?? 0) > 0) {
          skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: 'coverLetter', element, order });
          continue;
        }
        entries.push(planEntry(field, 'coverLetter', label, options.coverLetterFileName, order, 1));
        continue;
      }
      // 与 runner 写前那道 `hasApprovedResumeFileIdentity` **同源**：计划期认了、
      // 写入期不认，结果是整轮 IDENTITY_CHANGED（2026-09-15 Rippling 实测：这里靠
      // data-testid 认出，setFile 的正向钩子表却没有它）。它把标签、稳定钩子与
      // 有界的邻近上下文（前置标题 / 同容器旁文）一并计入，求职信等其它附件永远
      // 不得收下简历。描述符标签的否定判据仍额外保留——只会更严，不会更松。
      if (
        isNonResumeFileField(label, identities) ||
        !hasApprovedResumeFileIdentity(field.element, form.root)
      ) {
        skipped.push({ label, reason: 'UNSUPPORTED_CONTROL', required: field.required, key: field.key, element, order });
        continue;
      }
      if (!options.resumeFileName) {
        skipped.push({ label, reason: 'NO_VALUE', required: field.required, key: field.key, element, order });
        continue;
      }
      // 排在 NOT_EMPTY 之前：域名没确认时，用户该看到的是"确认这个网站"，
      // 而不是"这一栏已经有文件了"——后者会让人以为没事发生。
      if (!options.resumeHostConfirmed) {
        skipped.push({ label, reason: 'HOST_UNCONFIRMED', required: field.required, key: field.key, element, order });
        continue;
      }
      if (fillEmptyOnly && (field.element.files?.length ?? 0) > 0) {
        skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: field.key, element, order });
        continue;
      }
      entries.push(planEntry(field, 'resumeFile', label, options.resumeFileName, order, 1));
      continue;
    }

    const coverLetterTarget = field.kind === 'textarea'
      ? isCoverLetterField(label, [
          ...identities,
          element.getAttribute('aria-label'),
          element.getAttribute('placeholder'),
        ])
      : field.kind === 'richtext' &&
        field.plainTextContenteditableAttestation?.purpose === 'cover-letter';
    if (coverLetterTarget) {
      if (!options.coverLetterText || options.coverLetterText.trim() === '') {
        skipped.push({ label, reason: 'UNSUPPORTED_CONTROL', required: field.required, key: field.key, element, order });
        continue;
      }
      if (!options.coverLetterTargetVerified) {
        skipped.push({ label, reason: 'HOST_UNCONFIRMED', required: field.required, key: field.key, element, order });
        continue;
      }
      if (field.kind === 'richtext' && !hasPlainTextOnlyStructure(field.element)) {
        skipped.push({ label, reason: 'UNSUPPORTED_CONTROL', required: field.required, key: field.key, element, order });
        continue;
      }
      // This narrow material writer is exact-empty even when generic
      // fillEmptyOnly is disabled. Whitespace is user/host content too.
      if (readValue(field.element) !== '') {
        skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: field.key, element, order });
        continue;
      }
      if (field.kind === 'richtext') {
        const entry = plainTextContenteditablePlanEntry(
          field,
          label,
          options.coverLetterText,
          order,
        );
        if (!entry) {
          skipped.push({ label, reason: 'UNSUPPORTED_CONTROL', required: field.required, key: field.key, element, order });
          continue;
        }
        entries.push(entry);
      } else {
        entries.push(planEntry(field, 'coverLetter', label, options.coverLetterText, order, 1));
      }
      continue;
    }

    // No generic rich-text answer writer: every other contenteditable stays
    // visible/manual and cannot consume Profile values or guessed answers.
    if (field.kind === 'richtext') {
      skipped.push({ label, reason: 'UNSUPPORTED_CONTROL', required: field.required, key: field.key, element, order });
      continue;
    }

    // 电话的国际区号下拉（2026-09-28 Zalando「Country Code」，必填）：按号码自己写明的区号与居住国挑恰好一项，
    // 条目记在电话名下（它就是那个号码的一部分）；号码那一栏随之只写国内号段（`phoneValueFor`）。
    if (isCallingCodePicker(field) && (field.key === null || field.key === 'phone')) {
      const pick = callingCodeOption(field, resolved.phone, resolved.addressCountry);
      if (typeof pick === 'string') {
        skipped.push({ label, reason: pick, required: field.required, key: 'phone', element, order });
        continue;
      }
      if (fillEmptyOnly && readValue(field.element).trim() !== '') {
        skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: 'phone', element, order });
        continue;
      }
      const entry = planEntry(field, 'phone', label, pick.text, order, 0.75);
      entry.resolvedOptionText = pick.text;
      entries.push(entry);
      continue;
    }
    // 同一件事的搜索式单选（2026-09-28 adobe.wd5 的必填「Country Phone Code」）：网站多半按 Country 自己带出了一项——
    // 选着就不动它（页面上本来就有，不算「需要你」）；空着才按号码写明的区号去搜，条目同样记在电话名下。从前这一栏
    // 扫成没键的文本框，浮层说「我们没认出这一题」，连填停在第 1 页。
    if (isCallingCodePrompt(field, label) && (field.key === null || field.key === 'phone')) {
      if (promptSelections(field).length > 0) {
        skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: 'phone', element, order });
        continue;
      }
      const search = callingCodePromptQueries(resolved.phone, resolved.addressCountry);
      if (search === null) {
        skipped.push({ label, reason: 'NO_VALUE', required: field.required, key: 'phone', element, order });
        continue;
      }
      const entry = planEntry(field, 'phone', label, search.queries[0]!, order, 0.75, search.queries);
      if (entry.kind === 'combobox') entry.callingCode = search.code;
      entries.push(entry);
      continue;
    }

    // 认不出来、可页面上已经有值的那一栏（2026-10-04 Rippling：电话区号的搜索框，可读名只有「Search」，网站默认选好了
    // 「+1 US」，值就在这个输入框里）：不是「需要你」——网站或他自己已经答了。与认得出的栏同一个说法（NOT_EMPTY，
    // 页面上已有）。只认读得出值的文本类控件：单选／复选的 value 是选项自己的值，下拉的占位项也可能带值，都不算。
    if (!field.key && fillEmptyOnly && (field.kind === 'text' || field.kind === 'textarea' || field.kind === 'combobox') &&
      readValue(field.element).trim() !== '') {
      skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: field.key, element, order });
      continue;
    }
    if (!field.key) {
      // 认不出来的字段：不猜。用户在复核列表里看到"需手动填"。
      //
      // 其中作文 / 开放题与「和这家公司的历史」不是我们没认出来——答案不在任何档案键里，
      // 只有用户能答。它们从前和真正的低置信混报 LOW_CONFIDENCE（「没把握，没敢填」），
      // 用户读成我们的缺陷、等下个版本；报成 USER_ONLY（「这题只有你能答」），他才会去答
      // 或让 AI 起草（P4-15）。别的无键字段照旧 LOW_CONFIDENCE。
      const reason = isUserOnlyQuestion({ text: label, kind: field.kind }) ? 'USER_ONLY' : 'LOW_CONFIDENCE';
      skipped.push({ label, reason, required: field.required, key: field.key, element, order });
      continue;
    }
    if (field.confidence < MIN_APPLY_CONFIDENCE) {
      skipped.push({ label, reason: 'LOW_CONFIDENCE', required: field.required, key: field.key, element, order });
      continue;
    }
    // 电话元数据栏（分机 / 区号 / 设备类型）绝不接整串号码。
    //
    // ⚠️ 这道守卫此前是**死代码**——`dict/guards.ts` 定义了 `isPhoneMetaField`、
    // `tests/apply-guards.test.ts` 逐条验过 Phone extension / Area code / Device type /
    // 分机 / 区号，而 src/ 下一次都没被调用过。这是本仓第五次同一形状
    // （蜜罐守卫、推荐人守卫、JOB_DEPENDENT、gate/ 四件、这条）。
    //
    // 必须盖住 **attrMap**，不只是标签层：Greenhouse 的 `id="phone"` 以置信度 1
    // 直落 phone 键，而 CAP-AF-045 的 `maxlength ≤ 5` 兜底对**没写 maxlength**
    // 的分机栏失效——那一栏会收到整串手机号，回读判决还会通过（值确实在那儿），
    // 面板照报「已填」。属于"把没成功报成成功"那一族。
    //
    // 只对 phone 键生效：PHONE_GUARD 含 `type` / `device`，对所有键生效会误杀
    // 「Type of employment」这类正常字段。
    //
    // 例外只有一个：设备类型的**选择器**（2026-09-22 产品决定，有 cell / mobile 就选）。它收的是
    // 「这个号码是什么设备」，不是号码本身——candidatesFor 给它的候选是手机的各种写法，一个
    // 号码都没有。设备类型如果是**文本框**，照旧拦：往里写什么都只能是号码。
    const phoneDeviceTypePicker = field.kind !== 'text' && field.kind !== 'textarea' &&
      isPhoneDeviceTypeField(label);
    if (field.key === 'phone' && isPhoneMetaField(label) && !phoneDeviceTypePicker) {
      skipped.push({ label, reason: 'LOW_CONFIDENCE', required: field.required, key: field.key, element, order });
      continue;
    }

    // select 的判决前移到计划期（CAP-AF-044）：读 options 是纯被动动作。
    // 注定写不上/有歧义的条目不进计划——预览必须诚实；写入期仍重匹配一次。
    if (field.kind === 'select') {
      const selectCandidates = preferOtherCandidates(
        field.key,
        [...field.element.options].map((option) => option.text.trim()),
        candidatesFor(field, field.key, values, form.root, options.collections),
      );
      const selectValue = selectCandidates[0];
      if (!selectValue) {
        const optedOut = isSuppressed(options.suppressedKeys, field.key);
        skipped.push({
          label,
          reason: optedOut ? 'SENSITIVE_OPT_OUT' : 'NO_VALUE',
          required: field.required,
          key: field.key,
          element,
          order,
        });
        continue;
      }
      if (fillEmptyOnly && readValue(field.element).trim() !== '') {
        skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: field.key, element, order });
        continue;
      }
      // 阶梯匹配：候选按序试，第一个能在这张 <select> 上落下的胜出。
      // 扁平键只有一个候选，行为与从前逐字一致。
      const optionsList = [...field.element.options];
      let optionVerdict = resolveSelectOption(optionsList, selectValue);
      let chosenValue = selectValue;
      for (const candidate of selectCandidates.slice(1)) {
        if (optionVerdict !== 'NO_OPTION_MATCH' && optionVerdict !== 'AMBIGUOUS_OPTION') break;
        optionVerdict = resolveSelectOption(optionsList, candidate);
        chosenValue = candidate;
      }
      if (optionVerdict === 'NO_OPTION_MATCH' || optionVerdict === 'AMBIGUOUS_OPTION') {
        skipped.push({ label, reason: optionVerdict, required: field.required, key: field.key, element, order });
        continue;
      }
      const entry = planEntry(field, field.key, label, chosenValue, order);
      entry.resolvedOptionText = field.element.options[optionVerdict.index]?.text ?? '';
      const proxy = selectProxies.get(field.element);
      if (proxy !== undefined && entry.kind === 'select') {
        // 代选时按选项原文在面板里找整条相等的那一项：值就是那一项的文字。
        entry.selectProxy = proxy;
        entry.value = entry.resolvedOptionText;
      }
      entries.push(entry);
      continue;
    }

    const candidates = candidatesFor(field, field.key, values, form.root, options.collections);
    const value = candidates[0];
    if (!value) {
      // deriveProfile 已经把抑制键从 resolved 里删干净了（删除承诺的最后一环），
      // 所以走到这里的两种情况长得一模一样：用户主动关掉的，和档案里本来就没有的。
      // 它们的下一步动作相反，必须分开报。
      const optedOut = isSuppressed(options.suppressedKeys, field.key);
      skipped.push({
        label,
        reason: optedOut ? 'SENSITIVE_OPT_OUT' : 'NO_VALUE',
        required: field.required,
        key: field.key,
        element,
        order,
      });
      continue;
    }
    // Combobox raw text may be a search query, a display label, or empty while
    // the semantic backing is already selected. Keep it in the reviewed plan;
    // runner's rule-owned semantic pre-read decides MATCH/MISMATCH with zero
    // host clicks. All other control kinds retain the generic raw-value gate.
    if (
      field.kind !== 'combobox' &&
      fillEmptyOnly &&
      readValue(field.element).trim() !== ''
    ) {
      skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: field.key, element, order });
      continue;
    }

    if (field.kind === 'combobox') {
      // A several-value search prompt (Workday Skills) receives every candidate: the plan shows all of them,
      // one per line like any other multi-value answer, not just the first.
      const shown = field.multiple === true && field.listbox?.searchPrompt ? candidates.join('\n') : value;
      const entry = planEntry(field, field.key, label, shown, order, undefined, candidates);
      if (entry.kind !== 'combobox') {
        throw new Error('apply: combobox plan entry lost its discriminant');
      }
      const harvest = options.comboboxHarvests?.get(field.element);
      if (harvest) {
        if (!isBoundedComboboxHarvest(harvest)) {
          skipped.push({
            label,
            reason: 'IDENTITY_CHANGED',
            required: field.required,
            key: field.key,
            element,
            order,
          });
          continue;
        }
        const sameCandidates =
          harvest.candidates.length === candidates.length &&
          harvest.candidates.every((candidate, index) => candidate === candidates[index]);
        const signatureMatches =
          optionSetSignature(harvest.optionTexts) === harvest.optionSetSignature;
        const resolution = resolveOptionCandidate(candidates, harvest.optionTexts);
        if (!sameCandidates || !signatureMatches) {
          skipped.push({
            label,
            reason: 'IDENTITY_CHANGED',
            required: field.required,
            key: field.key,
            element,
            order,
          });
          continue;
        }
        if (resolution.kind !== 'MATCH') {
          skipped.push({
            label,
            reason: resolution.kind,
            required: field.required,
            key: field.key,
            element,
            order,
          });
          continue;
        }
        if (harvest.optionTexts[resolution.optionIndex] !== harvest.resolvedOptionText) {
          skipped.push({
            label,
            reason: 'IDENTITY_CHANGED',
            required: field.required,
            key: field.key,
            element,
            order,
          });
          continue;
        }
        const sealedHarvest: ComboboxOptionHarvest = Object.freeze({
          candidates: Object.freeze([...harvest.candidates]),
          optionTexts: Object.freeze([...harvest.optionTexts]),
          optionSetSignature: harvest.optionSetSignature,
          resolvedOptionText: harvest.resolvedOptionText,
        });
        entry.comboboxHarvest = sealedHarvest;
        entry.resolvedOptionText = sealedHarvest.resolvedOptionText;
      }
      entries.push(entry);
      continue;
    }

    entries.push(planEntry(field, field.key, label, phoneValueFor(field.key, value, formOwnsCallingCode), order));
  }

  // 档案里没有明确的 over18 时，计划里的每一条 over18 都是推出来的（文本框与说不清的题在循环里就没拿到
  // 推出来的值）：带上依据，浮层据此写明「按你的学历／工作经历推断」。
  if (adultByHistory) {
    for (const entry of entries) if (entry.key === 'over18') entry.historyBasis = 'ADULT_FROM_HISTORY';
  }

  // —— 分节与字段仲裁后处理（CAP-AF-045）——
  //
  // 此前循环末尾直接 push：同一个 canonical key 命中两个控件，两个都会被写。
  // 多节表单（地址段/教育段各有 City）上要么重复写同一栏触发宿主校验，要么
  // 把用户的城市写进"学校城市"。规则：每**节**每键至多一个，并列先比
  // confidence 再比 DOM 顺序；节 = autocomplete section token → fieldset →
  // 最近前置标题 → 整表一节。必须在指纹计算之前做——用户预览到的就是仲裁后的。

  const dropped = new Map<number, ApplyErrorCode>();

  // 理性化：键判成 phone 但 maxlength ≤ 5 装不下任何号码——那是分机/区号栏，
  // 写进去会被宿主截断成 "+1 5"。键匹配没错，形状说明匹配错了对象，降手填。
  // （规格原文的 type=number 在本仓本来就是 UNSUPPORTED_CONTROL，不经这里。）
  entries.forEach((entry, index) => {
    if (entry.key !== 'phone') return;
    const maxLength = Number.parseInt(entry.element.getAttribute('maxlength') ?? '', 10);
    if (Number.isInteger(maxLength) && maxLength > 0 && maxLength <= 5) {
      dropped.set(index, 'LOW_CONFIDENCE');
    }
  });

  const sections = entries.map((entry) => sectionKeyFor(entry.element));
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (dropped.has(index)) return;
    // 分组键要带**行标识**：两行各有一个 `experience.company` 不是重复，
    // 它们是两段不同的经历。签名的行标识段就是这个东西，从它取而不是另算一份——
    // 「计划里说的第 2 行」和「身份复核认的第 2 行」必须是同一个。
    const groupKey = `${sections[index]}\u0000${rowTagOf(entry.signature)}\u0000${entry.key}`;
    const group = groups.get(groupKey) ?? [];
    group.push(index);
    groups.set(groupKey, group);
  });
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    // 相邻的两个 email 是「邮箱 + 确认邮箱」：确认栏要的就是同值，两个都照填。
    // 只豁免恰好两个且相邻（中间无其他计划条目）的形态；第三个起照常仲裁。
    if (entries[indices[0]].key === 'email' && indices.length === 2 && indices[1] === indices[0] + 1) {
      continue;
    }
    // 「号码框 + 设备类型选择器」是同一个号码的两件事，不是重复的两栏：一个收号码，一个收
    // 「这是手机」。恰好一个文本类的号码框，其余是问设备类型的选项控件、或区号的选择器（各至多一个），才豁免。
    // 区号下拉（2026-09-28）与设备类型选择器同理：收的是号码的区号，不是第二个号码。Workday 第 1 页三样都在
    // 同一节（2026-09-28 adobe.wd5：Phone Device Type、Country Phone Code、Phone Number）。
    if (entries[indices[0]].key === 'phone' && indices.length >= 2 && indices.length <= 3) {
      const group = indices.map((index) => entries[index]!);
      const numbers = group.filter((entry) => entry.kind === 'text' || entry.kind === 'textarea');
      const deviceTypes = group.filter((entry) => entry.kind !== 'text' && entry.kind !== 'textarea' && isPhoneDeviceTypeField(entry.label));
      const callingCodes = group.filter((entry) =>
        (entry.kind === 'select' && (isPhoneCountryCodeField(entry.label) || isBareCountryCodeLabel(entry.label))) ||
        (entry.kind === 'combobox' && entry.callingCode !== undefined));
      if (numbers.length === 1 && deviceTypes.length <= 1 && callingCodes.length <= 1 &&
        numbers.length + deviceTypes.length + callingCodes.length === group.length) continue;
    }
    // 代填的条款同意、属实声明与签名各是一格独立的勾选或签名：同一节里两格（服务条款与隐私政策
    // 分开勾、两处声明各签一次）不是重复字段，一格都不能丢。
    if (indices.every((index) => entries[index]!.signOnBehalf !== undefined)) continue;
    // 同一件事、问法不同的选择题（2026-09-23 Discord：公司自订的「Race or Ethnicity (optional)」与标准段的
    // 条件题「Please identify your race」同节同键）：自我认同与工作授权这几类的答案对哪种问法都一样，
    // 题面不同就是两道题，两道都答。题面相同的仍是同一道题的重复控件，照常仲裁。
    if (isDistinctSameAnswerQuestions(indices.map((index) => entries[index]!))) continue;
    // 同一道题网站问了两遍（2026-10-04 Greenhouse Point72：同一句工作授权题、「How did you learn about this position?」
    // 各出现两次，两个下拉都标必填）：网站要两格都答，答案就是同一个——两格都留下。只认都必填、都是选项控件、题面是一整句
    // 问话的；文本栏同键多格（City）、只有一格必填的，照常仲裁。
    if (isRepeatedRequiredQuestion(indices.map((index) => entries[index]!))) continue;
    // 真要二选一时必填优先，再比置信度与页面顺序：落选的那一栏会被面板藏起来，不能是必填。
    const ranked = [...indices].sort(
      (left, right) =>
        Number(entries[right].required) - Number(entries[left].required) ||
        entries[right].confidence - entries[left].confidence ||
        left - right,
    );
    for (const loser of ranked.slice(1)) dropped.set(loser, 'DUPLICATE_FIELD');
  }

  // fullName 与 first+last 同节并存：同一信息进三栏，宿主把 Full name 当独立
  // 答案时就错了。保留更具体的拆分对；只有 fullName 时照常填。
  const keptKeysBySection = new Map<string, Set<string>>();
  entries.forEach((entry, index) => {
    if (dropped.has(index)) return;
    const kept = keptKeysBySection.get(sections[index]) ?? new Set<string>();
    kept.add(entry.key);
    keptKeysBySection.set(sections[index], kept);
  });
  entries.forEach((entry, index) => {
    if (dropped.has(index) || entry.key !== 'fullName') return;
    const kept = keptKeysBySection.get(sections[index]);
    if (kept?.has('firstName') && kept.has('lastName')) dropped.set(index, 'DUPLICATE_FIELD');
  });

  if (dropped.size > 0) {
    for (const [index, reason] of dropped) {
      skipped.push({
        label: entries[index].label,
        reason,
        required: entries[index].required,
        key: entries[index].key,
        element: entries[index].element,
        order: entries[index].order,
      });
    }
    const arbitrated = entries.filter((_, index) => !dropped.has(index));
    entries.length = 0;
    entries.push(...arbitrated);
  }

  // 宿主收下文件后常把上传控件整个换成「文件名 + 移除」（Greenhouse 在 change
  // 处理器里同步做），它后面每个控件的序号身份随之改变。文件最后写，其余字段
  // 在批准时的身份就一直有效。
  const filesLast = [
    ...entries.filter((entry) => entry.kind !== 'file'),
    ...entries.filter((entry) => entry.kind === 'file'),
  ];
  return { vendor: form.vendor, fingerprint: newPlanFingerprint(), fillEmptyOnly, entries: filesLast, skipped };
}

export interface ApplyPlanSummary {
  /** 会被写入的字段数。 */
  willFill: number;
  /**
   * 这张表一共有多少必填项，以及其中多少项**已经不需要用户操心**
   * （我们会填 + 页面上本来就填好了）。
   *
   * 分母比计数重要：竞品调研 2026-08-01 显示 Jobright 面板上的 `19/21` 量的
   * 正是当前表单的必填数。我们此前只有 `3 可填 / 4 待复核` 这种没有分母的
   * 平铺计数，用户看不出"还差多少才能提交"。
   */
  requiredTotal: number;
  requiredHandled: number;
  /** 认出了字段、但**用户资料里没有这一项**——要用户去补资料。 */
  missingProfile: number;
  /** 我们认出来了但不敢填，或页面拒绝了——要用户复核。 */
  needsReview: number;
  /**
   * 答案取决于具体岗位的题（工作授权/签证/期望薪资/到岗时间），只能用户自己答。
   * **不能并进 needsReview**：那会让用户以为是我们的能力问题，等下个版本就好了。
   */
  jobDependent: number;
  /** 控件类型还不支持——只能用户自己填。 */
  manual: number;
  /**
   * 用户主动关掉的一类（`suppressedKeys`）。**既不是用户待办，也不是我们的能力不足**，
   * 所以它独立于 `missingProfile` 与 `needsReview`，也不进必填分母。
   * 独立成一个数而不是干脆不计：静默跳过不等于凭空消失，面板仍要能说清这一项去哪了。
   */
  optedOut: number;
}

/**
 * 供 UI 直接显示的汇总。
 *
 * `missingProfile` 必须与 `needsReview` 分开：前者是**用户的待办**（去填资料），
 * 后者是**我们的能力不足**（认不出/不敢填）。合并成一个数字会在首次使用时
 * 显示成"0 可填 · 8 待复核"，让人以为插件坏了，实际只是资料还没填
 * （owner 截图 2026-07-29）。
 */
/**
 * 这几类的答案与问法无关：同一份资料对「Race or Ethnicity」与「Please identify your race」给的是同一个答案，
 * 对两种问法的工作授权题也一样。只在全部是选项控件（下拉、单选/复选组、组合框）时豁免——文本栏同键多格
 * 才是仲裁要防的形态（City 在地址段与教育段各一个）。跨性别、性取向、「是否 LGBTQ+」（2026-09-23）同理。
 */
const SAME_ANSWER_KEYS: ReadonlySet<string> = new Set([
  'eeoGender', 'eeoRace', 'eeoVeteran', 'eeoDisability', 'workAuthorization', 'workSponsorship',
  'eeoTransgender', 'eeoSexualOrientation', 'eeoLgbtqCommunity',
  // 「在这里工作过吗」与「现在在这里吗」（2026-09-24）同键不同题：答案逐题按问法算出来，题面不同就两道都答。
  'previouslyEmployedHere',
  // 年龄题（2026-09-24）同理：「年满 18 吗」「未满 18 吗」、以及「年满 18 且有权工作」答「否」的那一格都是 over18，
  // 答案逐题按题面算，题面不同就两道都答。
  'over18',
]);
const OPTION_ENTRY_KINDS: ReadonlySet<string> = new Set(['select', 'choice', 'combobox']);

function comparableQuestion(label: string): string {
  return label
    .toLowerCase()
    .replace(/[(（]\s*(?:optional|required|必填|选填|選填)\s*[)）]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * 按资料逐题推出来的那几类（2026-10-04）：答案按每一道题的题面算，同节同键的两道不同的题（「会说西语吗」「会说法语吗」）
 * 是两道题，不论是选项控件还是文本框，两道都答。题面相同的仍是同一道题的重复控件，照常仲裁。
 */
const PER_QUESTION_ANSWER_KEYS: ReadonlySet<string> = new Set([
  'workArrangement', 'languageAnswer', 'experienceYears', 'currentStudent', 'militaryService', 'travelAnswer',
]);

function isDistinctSameAnswerQuestions(group: readonly ApplyPlanEntry[]): boolean {
  if (group.every((entry) => PER_QUESTION_ANSWER_KEYS.has(entry.key))) {
    const questions = group.map((entry) => comparableQuestion(entry.label));
    return questions.every((question) => question !== '') && new Set(questions).size === questions.length;
  }
  if (!group.every((entry) => SAME_ANSWER_KEYS.has(entry.key) && OPTION_ENTRY_KINDS.has(entry.kind))) return false;
  const questions = group.map((entry) => comparableQuestion(entry.label));
  return questions.every((question) => question !== '') && new Set(questions).size === questions.length;
}

/** 一道题问了两三遍、每一格都必填、都是选项控件，题面是一整句问话（至少四个词）且逐字相同。 */
function isRepeatedRequiredQuestion(group: readonly ApplyPlanEntry[]): boolean {
  if (group.length < 2 || group.length > 3) return false;
  if (!group.every((entry) => entry.required && OPTION_ENTRY_KINDS.has(entry.kind))) return false;
  const questions = group.map((entry) => comparableQuestion(entry.label));
  const first = questions[0]!;
  return first.split(' ').length >= 4 && questions.every((question) => question === first);
}

export function summarizePlan(plan: ApplyPlan): ApplyPlanSummary {
  let missingProfile = 0;
  let needsReview = 0;
  let jobDependent = 0;
  let manual = 0;
  let optedOut = 0;
  let requiredTotal = 0;
  let requiredHandled = 0;
  for (const entry of plan.entries) {
    if (!entry.required) continue;
    requiredTotal += 1;
    requiredHandled += 1;
  }
  for (const item of plan.skipped) {
    if (item.reason === 'UNSUPPORTED_CONTROL') manual += 1;
    // 乙档预填走 manual 而不是 needsReview：下一步在用户手上（看一眼、点确认），
    // 不是我们认不出。needsReview 的定义就是「我们的能力不足」，把已经备好答案
    // 的题算进去，等于用自己的成果把自己的短板指标顶高。
    else if (item.reason === 'PREFILLED_NEEDS_CONFIRMATION') manual += 1;
    // 「这题只有你能答」同理走 manual：下一步是用户去答，不是我们认不出。
    else if (item.reason === 'USER_ONLY') manual += 1;
    else if (item.reason === 'NO_VALUE') missingProfile += 1;
    else if (item.reason === 'JOB_DEPENDENT') jobDependent += 1;
    else if (item.reason === 'SENSITIVE_OPT_OUT') optedOut += 1;
    else needsReview += 1;
    if (!item.required) continue;
    // 蜜罐与"他人"字段即使标了 required 也**不进分母**：它们永远不该被填，
    // 所以永远进不了分子。一个声明了 required 的蜜罐会把分母永久顶高一位，
    // 面板卡在 3/4，用户跑去页面上找那个不存在的第 4 项 —— 而唯一符合描述的
    // 就是那个隐藏陷阱字段。分母是我们刚上线的主指标，不能把用户往坑里引。
    // 用户主动关掉的一类同理进不了分子：我们不会去填它，所以把它算进分母只会让
    // opt-out 用户永远到不了 100%，用他自己的选择污染他自己的完成度。
    if (
      item.reason === 'HONEYPOT' ||
      item.reason === 'OTHER_PERSON' ||
      item.reason === 'SENSITIVE_OPT_OUT'
    ) {
      continue;
    }
    requiredTotal += 1;
    // NOT_EMPTY 表示页面上**已经有值**——对"还差多少才能提交"而言它已经完成，
    // 尽管我们没碰它。把它算进未完成会让一张填了一半的表看起来比实际更糟。
    if (item.reason === 'NOT_EMPTY') requiredHandled += 1;
  }
  return {
    willFill: plan.entries.length,
    missingProfile,
    needsReview,
    optedOut,
    jobDependent,
    manual,
    requiredTotal,
    requiredHandled,
  };
}

/** A reviewed answer for one host question; `element` is the control the answer targets. */
export interface QuestionAnswer {
  readonly questionId: string;
  readonly element: Element;
  readonly value: string;
}

/**
 * 用调用方（用户已审阅）的答案给档案计划跳过的字段做计划。
 *
 * 识别置信度在这里不适用——答案是用户看过的；安全守卫照旧：蜜罐与铁律 5 甲档
 * （密码 / 验证码 / 授权同意）拒绝，runner 写不了的控件报 UNSUPPORTED_CONTROL，
 * 没有答案的字段不进计划。产出的计划与档案计划走同一条 runner / 撤销日志 / 能力位的路。
 */
export function buildAnswerPlan(
  form: ApplyFormDescriptor,
  answers: readonly QuestionAnswer[],
  options: Pick<BuildPlanOptions, 'readGeometry' | 'capabilities'> = {},
): ApplyPlan {
  const byElement = new Map(answers.map((answer) => [answer.element, answer]));
  const answered = form.fields.filter((field) => byElement.get(field.element)?.value.trim());
  // 与 buildApplyPlan 同一套几何标定：环境会布局（有任何一个控件有真实尺寸）才启用几何蜜罐层。
  const readGeometry = options.readGeometry;
  const geometries = new Map(answered.map((field) => [field.element, readGeometry === undefined ? undefined : honeypotGeometryOf(field, readGeometry)]));
  const geometryActive = [...geometries.values()].some((geometry) => geometry && geometry.width > 1 && geometry.height > 1);
  const entries: ApplyPlanEntry[] = [];
  const skipped: ApplyPlan['skipped'] = [];
  for (const [order, field] of form.fields.entries()) {
    const answer = byElement.get(field.element);
    if (!answer || answer.value.trim() === '') continue;
    const element = field.element;
    const label = field.label || field.key || '';
    const key: QuestionAnswerKey = `question:${answer.questionId}`;
    const skip = (reason: ApplyPlan['skipped'][number]['reason']): void => {
      skipped.push({ label, reason, required: field.required, key, element, order });
    };
    const geometry = geometryActive && field.kind !== 'file' ? geometries.get(element) : undefined;
    if (
      isHoneypot({
        text: [label, element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.getAttribute('title')]
          .filter((value): value is string => Boolean(value))
          .join(' '),
        identities: ['name', 'id', 'data-automation-id', 'data-ui', 'data-qa', 'data-testid'].map((name) => element.getAttribute(name)),
        ...(geometry ? { geometry } : {}),
      })
    ) {
      skip('HONEYPOT');
      continue;
    }
    if (isManualIdentityQuestion(`${label} ${questionContextOf(element)}`) || isNeverWritableControl({ text: label, inputType: element.getAttribute('type'), autocomplete: element.getAttribute('autocomplete') })) {
      skip('MANUAL_ONLY');
      continue;
    }
    // 他人信息栏在这条路上此前**没有守卫**：一个经审阅的答案可以写进推荐人栏，
    // 而档案计划那条路会拒。同一条能力位管两条路，默认关闭时两边一致 fail closed。
    if (isOtherPersonField(label) && options.capabilities?.['set-other-person'] !== true) {
      skip('OTHER_PERSON');
      continue;
    }
    if (field.kind === 'unsupported' || field.kind === 'file' || field.kind === 'richtext') {
      skip('UNSUPPORTED_CONTROL');
      continue;
    }
    // 选项类答案按行给出选项文字：单选恰好一行，多选每行一个；有一行认不出就整题不写。
    const lines = answer.value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (field.kind === 'choice') {
      const chosen = chosenOptions(field.choice, lines);
      if (chosen === null) {
        skip('NO_VALUE');
        continue;
      }
      entries.push(planEntry(field, key, label, chosen.join('\n'), order, 1));
      continue;
    }
    const multiValue = field.kind === 'combobox' && field.multiple === true;
    entries.push(planEntry(field, key, label, answer.value, order, 1, multiValue ? lines : undefined, multiValue));
  }
  return { vendor: form.vendor, fingerprint: newPlanFingerprint(), fillEmptyOnly: true, entries, skipped };
}

/**
 * 一份计划、一个 authority：档案字段与**已记住的答案**同一批写。
 *
 * 记忆答案的正当性来自「用户早就答过、并选择记住」，不是来自当场那一次点击，
 * 所以它没有第二次手势可铸第二张票——它必须坐进档案计划那一张里。两类条目共用
 * 同一个 fingerprint、同一次 runner、同一本撤销日志。
 *
 * 顺序上档案先于记忆：档案是本人资料的权威，记忆只补它没认领的控件。守卫不因为
 * 「答案是记住的」而放松——蜜罐、铁律 5 甲档与写不了的控件照旧在 buildAnswerPlan
 * 里先判，与用户当场审阅过的答案走同一段代码。
 */
export function buildFillPlan(
  form: ApplyFormDescriptor,
  profile: ApplyProfileDraft,
  answers: readonly QuestionAnswer[],
  options: BuildPlanOptions = {},
): ApplyPlan {
  const base = buildApplyPlan(form, profile, options);
  if (answers.length === 0) return base;
  const owned = new Set<Element>(base.entries.map((entry) => entry.element));
  const answered = buildAnswerPlan(
    form,
    answers.filter((answer) => !owned.has(answer.element)),
    options,
  );
  // 记忆对某个控件下了判断（写或拒写）时，那一行就以记忆的判断为准：面板上一个控件
  // 只该有一行，否则同一栏会同时显示「缺资料」与「已填」。
  const decided = new Set<Element>(
    [...answered.entries, ...answered.skipped].map((item) => item.element),
  );
  const entries = [...base.entries, ...answered.entries];
  return {
    ...base,
    fingerprint: newPlanFingerprint(),
    // 文件仍然最后写：宿主收下文件常把后面控件的序号身份整个换掉（见 buildApplyPlan）。
    entries: [
      ...entries.filter((entry) => entry.kind !== 'file'),
      ...entries.filter((entry) => entry.kind === 'file'),
    ],
    skipped: [
      ...base.skipped.filter((item) => !decided.has(item.element)),
      ...answered.skipped,
    ],
  };
}

/**
 * 「I currently work here」这一格的计划。只认**恰好一个原生勾选框**的形状：别的形状（单选组、代理）
 * 说不清「勾上」对应哪一项，交还用户。
 */
function planCurrentRowCheckbox(
  entries: ApplyPlanEntry[],
  skipped: ApplyPlan['skipped'],
  field: Extract<ApplyFieldDescriptor, { kind: 'choice' }>,
  label: string,
  order: number,
  root: ScanRoot,
  collections: ApplyProfileCollections | undefined,
): void {
  const skip = (reason: ApplyErrorCode) =>
    skipped.push({ label, reason, required: field.required, key: field.key, element: field.element, order });
  const choice = field.choice;
  if (choice.control !== 'checkbox' || choice.options.length !== 1) {
    skip('CHOICE_NO_DATA');
    return;
  }
  const rowIndex = fieldRowIndex(field.element, root) ?? 0;
  if (collections === undefined || (collections.experiences ?? [])[rowIndex] === undefined) {
    skip('NO_VALUE');
    return;
  }
  if (!isCurrentRow(collections, 'experience', rowIndex) || choiceAlreadyAnswered(field)) {
    skip('NOT_EMPTY');
    return;
  }
  entries.push(planEntry(field, 'experience.isCurrent', label, choice.options[0]!.label, order));
}

/** 单选／复选组里已经有成员被选上：fill-first 不覆盖用户（或宿主默认）作过的选择。 */
function choiceAlreadyAnswered(field: Extract<ApplyFieldDescriptor, { kind: 'choice' }>): boolean {
  const choice = field.choice;
  // ARIA 代理题（2026-09-23）问宿主公布的状态：Workable 的隐藏 radio 与 aria-checked 会不一致，
  // Ashby 的镜像只镜像 Yes——原生 `checked` 在这一类题上不是证据。读不出（null）按已答算：
  // 说不清的状态不是可以覆盖的空白。
  if (choice.control === 'proxy') {
    return choice.options.some((option) => ariaProxyPressed(option.element, choice.proxy) !== false);
  }
  return choice.options.some((option) => option.element.checked);
}

/**
 * ARIA 代理题上能不能以用户名义代填这一类（见主循环里那一段）：条款同意、属实声明不行（2026-09-23
 * 的放行范围不含代理题）；第三刀的六类同意可以，但题干必须来自页面上的一个元素——点击当下要从它把
 * 题干重新读一遍、再认一遍（Ashby 的是非按钮自己的可读名只有「YesNo」）。
 */
function signOnBehalfProxyAllowed(field: ApplyFieldDescriptor, kind: SignOnBehalfKind): boolean {
  if (field.kind !== 'choice' || field.choice.control !== 'proxy') return true;
  return isWholeQuestionKind(kind) && (field.choice.question ?? null) !== null;
}

/** 这一类在这一轮获准吗（能力位另判）。没有显式的本轮授权类别，一律拒绝。 */
function signOnBehalfKindAllowed(options: BuildPlanOptions, kind: SignOnBehalfKind): boolean {
  return options.signOnBehalfKinds?.has(kind) === true;
}

/** 认出来的一格代填：哪一类；选择类控件还带上要选的那一项。 */
type SignOnBehalfTarget = Readonly<{ kind: SignOnBehalfKind; answer?: OptionAnswer }>;

/**
 * 这一栏是不是可代填的条款同意、属实声明、同意类或签名（dict/signOnBehalf.ts）。
 *
 * - 单个复选框：题面就是它自己那句话（第一版，NVIDIA 第 4 页实测）。
 * - 单选组、复选组、原生下拉（第二刀，2026-09-23）：选项在手上，`signOnBehalfChoiceAnswer` 恰好挑出
 *   一项才算——题面判得出时挑那一句肯定回答，题面判不出（或只是同一类的标题）时挑那一句本身就是
 *   同意的选项。ARIA 代理题同样（第三刀，2026-09-24，只认六类同意）。
 * - 组合框：菜单要点开才有，只认题面判得出的（同意类另认同一类的标题，例如「Agreement to Arbitrate」）；
 *   写入期撞真实菜单，点下去那一下点击策略还要把题面和选项各认一遍。只认 listbox 那一种部件：
 *   typeahead、分层菜单、受控语义那几条写入路径不带代填标记，点击策略替不了它们把关。多选的不认。
 */
function signOnBehalfTargetOf(
  field: ApplyFieldDescriptor,
  label: string,
  employerContact: EmployerContactAnswer | undefined,
): SignOnBehalfTarget | null {
  switch (field.kind) {
    case 'text': {
      const kind = signatureFieldKind(label);
      return kind === null ? null : { kind };
    }
    case 'choice': {
      const options = field.choice.options.map((option) => option.label);
      const loneCheckbox = field.choice.control === 'checkbox' ||
        (field.choice.control === 'proxy' && field.choice.proxy === 'checkbox');
      if (loneCheckbox && options.length === 1) {
        const kind = signOnBehalfChoiceKind(label) ?? employerContactCheckboxKind(label, employerContact);
        return kind === null ? null : { kind, answer: { value: options[0]! } };
      }
      return chosenSignOnBehalfOption(label, options, employerContact);
    }
    case 'select':
      return chosenSignOnBehalfOption(label, [...field.element.options].map((option) => option.text), employerContact);
    case 'combobox': {
      const listbox = field.listbox;
      if (field.multiple || listbox === undefined || listbox.typeahead !== undefined || listbox.hierarchicalPrompt !== undefined) {
        return null;
      }
      const kind = signOnBehalfCheckboxKind(label) ?? consentOnBehalfKind(label) ?? consentTopicTitle(label) ??
        widenedConsentKind(label) ?? widenedTopicTitle(label) ?? (privacyNoticeTitle(label) ? 'PRIVACY_NOTICE_TITLE' : null);
      if (kind !== null) {
        return { kind, answer: { value: SIGN_ON_BEHALF_COMBOBOX_ANSWERS[0]!, comboboxCandidates: SIGN_ON_BEHALF_COMBOBOX_ANSWERS } };
      }
      // 能不能联系雇主（2026-09-28）：菜单要点开才有，写入期按类别里的方向撞真实菜单（`signOnBehalfAnswerFor`）。
      const subject = employerContact === undefined ? null : employerContactSubject(label);
      if (subject === null || employerContact === undefined) return null;
      const yes = employerContact === 'YES';
      return {
        kind: subject === 'CURRENT'
          ? (yes ? 'EMPLOYER_CONTACT_YES' : 'EMPLOYER_CONTACT_NO')
          : (yes ? 'REFERENCE_CONTACT_YES' : 'REFERENCE_CONTACT_NO'),
        answer: { value: yes ? 'Yes' : 'No', comboboxCandidates: [yes ? 'Yes' : 'No'] },
      };
    }
    default:
      return null;
  }
}

function chosenSignOnBehalfOption(
  label: string,
  options: readonly string[],
  employerContact: EmployerContactAnswer | undefined,
): SignOnBehalfTarget | null {
  const chosen = signOnBehalfChoiceAnswer(label, options) ??
    (employerContact === undefined ? null : employerContactAnswer(label, options, employerContact));
  return chosen === null ? null : { kind: chosen.kind, answer: { value: options[chosen.index]! } };
}

/** 每一类代填写在哪个条目键下（浮层按键逐条写明「已替你…」）。 */
export const SIGN_ON_BEHALF_ENTRY_KEY: Readonly<Record<SignOnBehalfKind, ApplyEntryKey>> = Object.freeze({
  TERMS_CONSENT: 'termsConsent',
  TRUTH_ATTESTATION: 'truthAttestation',
  SIGNATURE_NAME: 'signatureName',
  SIGNATURE_DATE: 'signatureDate',
  AI_RECORDING_CONSENT: 'aiRecordingConsent',
  SMS_CONSENT: 'smsConsent',
  FUTURE_CONTACT_CONSENT: 'futureContactConsent',
  MARKETING_CONSENT: 'marketingConsent',
  BACKGROUND_CHECK_CONSENT: 'backgroundCheckConsent',
  ARBITRATION_AGREEMENT: 'arbitrationAgreement',
  RECRUITING_DATA_SHARING: 'recruitingDataSharingConsent',
  INFORMATION_VERIFICATION: 'informationVerificationConsent',
  SCREENING_CONSENT: 'screeningConsent',
  AT_WILL_ACKNOWLEDGEMENT: 'atWillAcknowledgement',
  ARBITRATION_WAIVER: 'arbitrationWaiver',
  AI_INTERVIEW_ANALYSIS: 'aiInterviewAnalysisConsent',
  CALL_NOTIFICATION_CONSENT: 'callNotificationConsent',
  GROUP_FUTURE_CONTACT: 'groupFutureContactConsent',
  PRIVACY_NOTICE_TITLE: 'privacyNoticeAcknowledgement',
  COMBINED_CONSENT: 'combinedConsent',
  EMPLOYER_CONTACT_YES: 'employerContactAllowed',
  EMPLOYER_CONTACT_NO: 'employerContactDeclined',
  REFERENCE_CONTACT_YES: 'referenceContactAllowed',
  REFERENCE_CONTACT_NO: 'referenceContactDeclined',
});

/**
 * 把一格代填排进计划；排不进（值给不出来）返回 false，由调用方落 MANUAL_ONLY。
 *
 * 置信度按 1 记：这几栏在扫描里没有档案键（描述符置信度是 0），而 runner 会拿它跟策略的
 * minConfidence 比、把条目拦成 LOW_CONFIDENCE。它们认得出来靠的是 signOnBehalf 那组整句语法，
 * 不是键匹配。
 */
function planSignOnBehalf(
  entries: ApplyPlanEntry[],
  skipped: ApplyPlan['skipped'],
  field: ApplyFieldDescriptor,
  target: SignOnBehalfTarget,
  label: string,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
  order: number,
  fillEmptyOnly: boolean,
  signingDate: string | undefined,
): boolean {
  const { kind } = target;
  const key = SIGN_ON_BEHALF_ENTRY_KEY[kind];
  if (target.answer !== undefined) {
    const before = entries.length;
    if (!pushOptionAnswer(entries, skipped, field, key, label, target.answer, order, fillEmptyOnly)) return false;
    const entry = entries[before];
    if (entry !== undefined) {
      entry.signOnBehalf = kind;
      const wording = signedWordingOf(kind, label, target.answer.value);
      if (wording !== null) entry.signedWording = wording;
    }
    return true;
  }
  if (field.kind !== 'text') return false;
  if (fillEmptyOnly && readValue(field.element).trim() !== '') {
    skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key, element: field.element, order });
    return true;
  }
  const value = kind === 'SIGNATURE_NAME' ? resolved.fullName?.trim() ?? '' : signingDateValue(field.element, signingDate);
  if (value === '') return false;
  entries.push({ ...planEntry(field, key, label, value, order, 1), signOnBehalf: kind });
  return true;
}

/** 代填行的标题要用选项那句话：至少这么多个词（「Yes」「I agree」说不清替他同意了什么）。 */
const SIGNED_WORDING_MIN_WORDS = 4;

/**
 * 代填的那一格，题面自己说不出是哪一类、靠选项那句话认出来的（2026-10-04：Ashby 的短信同意借了电话栏的「Phone」）：
 * 那句话就是这一行的标题。题面自己说得出（单个勾选框的整句、「Do you consent to …?」、同一类的标题），或者选项太短说不清，
 * 都是 null——照旧用题面。能不能联系雇主按资料答，题面就是那一问，照旧用题面。
 */
function signedWordingOf(kind: SignOnBehalfKind, label: string, chosen: string): string | null {
  if (kind.startsWith('EMPLOYER_CONTACT_') || kind.startsWith('REFERENCE_CONTACT_')) return null;
  const labelSays = signOnBehalfChoiceKind(label) ?? signOnBehalfCheckboxKind(label) ?? consentOnBehalfKind(label) ??
    consentTopicTitle(label) ?? widenedConsentKind(label) ?? widenedTopicTitle(label);
  if (labelSays !== null || privacyNoticeTitle(label)) return null;
  const wording = chosen.replace(/\s+/gu, ' ').trim();
  return wording.split(' ').filter((word) => /[\p{L}\p{N}]/u.test(word)).length >= SIGNED_WORDING_MIN_WORDS ? wording : null;
}

/** 签名日期：`type=date` 写 ISO；自由文本框按那一栏 placeholder 的掩码写；别的控件不代填。 */
function signingDateValue(element: Element, signingDate: string | undefined): string {
  if (signingDate === undefined || !ISO_DATE.test(signingDate)) return '';
  const type = (element.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'date') return signingDate;
  if (!isFreeTextInput(element)) return '';
  return maskedDateCandidates(signingDate, element.getAttribute('placeholder'))[0] ?? '';
}

/** 一道「选一项」的题在三种控件上各自怎么落笔：单选／复选与原生下拉在计划期就定下那一项的原文；组合框把候选交给写入期去撞真实菜单。 */
type OptionAnswer = Readonly<{ value: string; comboboxCandidates?: readonly string[] }>;
type OptionControl = Extract<ApplyFieldDescriptor, { kind: 'choice' | 'select' | 'combobox' }>;

function isOptionControl(field: ApplyFieldDescriptor): field is OptionControl {
  return field.kind === 'choice' || field.kind === 'select' || field.kind === 'combobox';
}

/**
 * 档案里的一个枚举值（EEO 四档的码、或 YES / NO）在这个控件上对应哪一项。
 *
 * 2026-09-21 之前只认单选钮：Greenhouse job-boards 上**所有**下拉都是 react-select 组合框
 * （工作授权、「你现在人在 X 吗」、EEO 四题全是），于是这些题在最常见的一家 ATS 上一次都没
 * 填过。三种控件三种落法：
 * - 单选／复选、原生下拉：选项文字在计划期就在手上，`selfIdentificationOption` 按法定措辞
 *   恰好命中一项才算（零个或多个都不写）。
 * - 组合框：菜单要点开才有，计划期给一串闭集候选（同一个值的几种法定写法），写入期
 *   `resolveOptionCandidate` 逐个去撞真实选项，同样恰好一项才落笔，歧义即停。
 */
function optionAnswer(field: OptionControl, storedValue: string): OptionAnswer | null {
  switch (field.kind) {
    case 'choice':
    case 'select': {
      const option = selfIdentificationOption(storedValue, optionTexts(field));
      return option === null ? null : { value: option };
    }
    case 'combobox': {
      const candidates = selfIdentificationComboboxCandidates(storedValue);
      return candidates.length === 0 ? null : { value: candidates[0]!, comboboxCandidates: candidates };
    }
    default:
      return assertNever(field, 'optionAnswer field kind');
  }
}

/**
 * 「在这里工作过吗」答「否」、页面上又没有「No」那一项时（2026-09-24 adobe.wd5 那一组身份复选框）：经历里根本没有这家，
 * 就选「没在这家工作过」的那一项（dict/historyAnswers.ts 的 `notEmployedOption`，恰好一项才选）。答「是」不猜是哪种身份；
 * 那段经历已经结束（问「现在」答「否」）时这句话不成立，也不选。组合框的菜单要点开才有，这一步不做。
 */
function neverEmployedAnswer(field: OptionControl, basis: HistoryAnswerBasis, jobCompany: string): OptionAnswer | null {
  if (basis !== 'EMPLOYER_NOT_IN_HISTORY' || field.kind === 'combobox') return null;
  const option = notEmployedOption(optionTexts(field), jobCompany);
  return option === null ? null : { value: option };
}

/** 单选／复选与原生下拉上用户看到的选项文字（组合框的菜单要点开才有，不在这里）。 */
function optionTexts(field: Exclude<OptionControl, { kind: 'combobox' }>): string[] {
  return field.kind === 'choice'
    ? field.choice.options.map((item) => item.label)
    : [...field.element.options].map((item) => item.text);
}

/**
 * 把一个定下来的答案排进计划；fill-first 不覆盖页面上已选的（单选组有成员被勾、下拉已选中
 * 非空项）。组合框的「已选」要读部件自己的显示位，那一步在写入期由 runner 判，这里不重复。
 * 返回 true 表示这一栏已处理（进了 entries 或按 NOT_EMPTY 进了 skipped）。
 */
function pushOptionAnswer(
  entries: ApplyPlanEntry[],
  skipped: ApplyPlan['skipped'],
  field: ApplyFieldDescriptor,
  key: ApplyEntryKey,
  label: string,
  answer: OptionAnswer,
  order: number,
  fillEmptyOnly: boolean,
  /** 工作授权答案的依据（按岗位地点推断的国家）：原样挂到条目上，浮层据此写明。 */
  basis?: WorkAuthorizationBasis,
): boolean {
  if (!isOptionControl(field)) return false;
  const element = field.element;
  const taken = field.kind === 'choice'
    ? choiceAlreadyAnswered(field)
    : field.kind === 'select'
      ? readValue(field.element).trim() !== ''
      : false;
  if (fillEmptyOnly && taken) {
    skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key, element, order });
    return true;
  }
  const entry = planEntry(field, key, label, answer.value, order, 1, answer.comboboxCandidates);
  if (entry.kind === 'select') entry.resolvedOptionText = answer.value;
  Object.assign(entry, basis);
  entries.push(entry);
  return true;
}

/**
 * 扁平档案值 → 这道单选／复选题该勾的选项原文（按选项顺序）；对不上就 null。
 *
 * 每个码只认**恰好一项**：候选按 `flatValueCandidates` 的顺序试（码本身、再人读写法），
 * 第一个在页面上恰好命中一项的胜出；一个码在页面上命中零项或多项就整题不写——
 * 单选题多勾一项是错答，少勾一项是漏答，两者都不该由我们替他决定。
 * 集合值（'REMOTE,HYBRID'）逐码一项；单选题只许一码。
 */
/**
 * 两道题优先选「Other」（产品决定，2026-09-22）。
 *
 * **来源题（heardAboutSource）**：用户是通过 Argoland 来申请的，来源归因到 Argoland。只要
 * 列表里有明写 `Other` 的那一项就**优先**选它，哪怕档案里的来源（例如 LinkedIn）也在列表里；
 * 没有 Other 时照旧按档案填。只认以 other 起头的那一项——「None of the above」不是 Other。
 * 这会覆盖用户自己在档案里填的来源，是有意的；面板在提交前把选中的那一项原样显示出来。
 *
 * **学校（education.school）**：校名对不上时退到「Other / not listed」那一项。2026-09-22 在
 * palantir 的真实申请页上，学校是 3302 项的下拉，题干自己写着「不在列表里就选 Other」，列表里
 * 那一项的真实文字是 `Other - School Not Listed`。Other 只垫在**最后**：校名对得上时照旧填校名。
 * 档案里一段教育都没有时不垫——那时我们不知道他上的是哪所，选 Other 等于替他编。
 *
 * 其他键一律不动：国家对不上就是对不上，不许退到 Other。
 */
const OTHER_OPTION = /^\s*other\b/i;
const NOT_LISTED_OPTION = /^\s*other\b|\bnot\s+listed\b/i;

function preferOtherCandidates(
  key: ApplyEntryKey,
  optionTexts: readonly string[],
  candidates: readonly string[],
): readonly string[] {
  if (key === 'heardAboutSource') {
    const other = optionTexts.find((text) => OTHER_OPTION.test(text));
    return other === undefined ? candidates : [other, ...candidates.filter((candidate) => candidate !== other)];
  }
  if (key === 'education.school' && candidates.length > 0) {
    const other = optionTexts.find((text) => NOT_LISTED_OPTION.test(text));
    return other === undefined ? candidates : [...candidates, other];
  }
  return candidates;
}

function keyedChoiceLines(
  field: Extract<ApplyFieldDescriptor, { kind: 'choice' }>,
  key: ApplyFieldKey,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
): readonly string[] | null {
  // 来源题有 Other 就只选 Other（见 `preferOtherCandidates`）——在「档案有没有值」之前判：
  // 这是按题定的产品规则，不取决于用户档案里填了什么。
  if (key === 'heardAboutSource') {
    const other = field.choice.options.map((option) => option.label).find((text) => OTHER_OPTION.test(text));
    if (other !== undefined) return chosenOptions(field.choice, [other]);
  }
  const value = resolved[key];
  if (!value) return null;
  const codes = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (codes.length === 0) return null;
  if (isSingleChoiceGroup(field.choice) && codes.length !== 1) return null;
  const labels = field.choice.options.map((option) => option.label);
  const lines: string[] = [];
  for (const code of codes) {
    const hit = flatValueCandidates(key, code, 'options')
      .map((candidate) => labels.filter((optionLabel) => sameText(optionLabel, candidate)))
      .find((matches) => matches.length === 1);
    if (hit === undefined) return null;
    lines.push(hit[0]!);
  }
  return chosenOptions(field.choice, lines);
}

/**
 * EEO 自我认同能不能预填。
 *
 * 四道都过才算数，缺一道就退回 MANUAL_ONLY：
 *
 *  1. 能力位 `set-self-identification` 打开——包内默认 false，要后端按策略下发。
 *  2. 题目属于认得的那几档（法定四档，加 2026-09-23 起的跨性别、性取向、LGBTQ+；代词不在其内）。
 *  3. 档案里**有值**。`DECLINE` 也是一个值：「不愿回答」在美国申请表上是法律要求
 *     雇主提供的选项，用户选了它就该照样勾。而**没有值**时不能替他选任何一项，
 *     包括不能替他选 DECLINE。
 *  4. 这是一个选择控件，且页面上**恰好有一个**选项对得上那个值。
 *
 * 第 4 道是为了不许一个空头承诺：说了「已预填」却没有可勾的选项，用户在面板上
 * 会看到一个点不动的条目，比直接说「这题你自己答」还糟。
 */
function selfIdentificationPrefill(
  field: ApplyFieldDescriptor,
  label: string,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
  options: BuildPlanOptions,
): Readonly<{ key: ApplyEntryKey; answer: OptionAnswer }> | null {
  if (options.capabilities?.['set-self-identification'] !== true) return null;
  const concept = selfIdentificationConcept(label);
  if (concept === null) return null;
  const key = SELF_IDENTIFICATION_KEYS[concept];
  const value = selfIdentificationValue(concept, label, resolved, options);
  if (value === undefined || value === '') return null;
  if (!isOptionControl(field)) return null;
  // 跨性别与 LGBTQ+ 答的是 是／否／不愿回答：页面上的选项得真是这一种（各恰好一项 Yes 与 No），
  // 否则判读错了题也不至于替他在别的题上选了「不愿回答」。组合框的菜单要点开才有，它的候选
  // 本身就只有 Yes、No 与不愿回答的法定说法。
  if ((concept === 'TRANSGENDER' || concept === 'LGBTQ_COMMUNITY') && !offersYesAndNo(field)) return null;
  const answer = optionAnswer(field, value);
  return answer === null ? null : { key, answer };
}

/** 这一档题该答的那个码；没有依据就 undefined。 */
function selfIdentificationValue(
  concept: SelfIdentificationConcept,
  label: string,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
  options: BuildPlanOptions,
): string | undefined {
  switch (concept) {
    case 'TRANSGENDER':
      return transgenderAnswer(label, options.transgenderStatus) ?? undefined;
    case 'SEXUAL_ORIENTATION':
      return options.sexualOrientation;
    case 'LGBTQ_COMMUNITY':
      return lgbtqCommunityAnswer(label, {
        ...(options.transgenderStatus === undefined ? {} : { transgender: options.transgenderStatus }),
        ...(options.sexualOrientation === undefined ? {} : { orientation: options.sexualOrientation }),
        ...(resolved.eeoGender === undefined ? {} : { gender: resolved.eeoGender }),
      }) ?? undefined;
    case 'GENDER':
    case 'RACE':
    case 'VETERAN':
    case 'DISABILITY':
      break;
    default:
      return assertNever(concept, 'self-identification concept');
  }
  // 把族裔单拎出来问的是否题（「Are you Hispanic/Latino?」）：选项是 Yes/No，
  // 不是族裔名，所以要答的值是 YES / NO / DECLINE 而不是那个枚举。
  //
  // 用户在门户里单独答过这一问（2026-09-23 起带过来）就照他的话答。没答过时只有种族码
  // 确实是拉美裔才有依据：种族是单值，表达不了「既是亚裔又是拉美裔」，所以选了别的值
  // **推不出「否」**——宁可让用户自己答一次，也不替他否认一个我们并不知道的事实。
  if (isHispanicOriginQuestion(label)) {
    return options.hispanicLatino ?? (resolved.eeoRace === 'HISPANIC_OR_LATINO' ? 'YES' : undefined);
  }
  return resolved[SELF_IDENTIFICATION_KEYS[concept] as ApplyFieldKey];
}

/** 单选／原生下拉上各恰好有一项 Yes 与一项 No；组合框计划期看不到菜单，交给候选。 */
function offersYesAndNo(field: OptionControl): boolean {
  if (field.kind === 'combobox') return true;
  const labels = optionTexts(field);
  return selfIdentificationOption('YES', labels) !== null && selfIdentificationOption('NO', labels) !== null;
}

/**
 * 每一档写进哪个条目键。三档新题各有自己的键、不借用 eeoGender：条目键说的是这一格写的是哪件事，
 * 写入面按它批准（kernelFiller 只在那句回答交来了时放行这三个键），审计也按它认。
 */
const SELF_IDENTIFICATION_KEYS: Readonly<Record<SelfIdentificationConcept, ApplyEntryKey>> =
  Object.freeze({
    GENDER: 'eeoGender',
    RACE: 'eeoRace',
    VETERAN: 'eeoVeteran',
    DISABILITY: 'eeoDisability',
    TRANSGENDER: 'eeoTransgender',
    SEXUAL_ORIENTATION: 'eeoSexualOrientation',
    LGBTQ_COMMUNITY: 'eeoLgbtqCommunity',
  });

/**
 * 工作授权／担保能不能预填（`workAuthorizationFact` / `workAuthorizationPrefill`）。
 *
 * 与 EEO 同样是四道串联的筛，但第三道不一样——它问的不是「档案里有没有值」，
 * 而是「**这道题说的是哪一国**，用户在那一国手上有没有一条当前有效的记录」：
 *
 *  1. 能力位 `set-work-authorization` 打开——包内默认 false。
 *  2. 题目属于这三类之一：有权工作、要不要担保（担保先判：有的句子同时含两类词，问的是担保）、
 *     不需担保就有权工作。
 *  3. 说得出**恰好一国**：题目点名的那一国；题目一个地方都没提（「the country in which this role
 *     is located」，语料里一半以上是这种）时，调用方从申请卡片确定性地解出的岗位国家（P1-7）。
 *     点名了两国、问的是「你现在住的国家」、解不出岗位国家的，一律不答。点名美国的一个州（全名）就是美国，
 *     从不落到同码的国家（加州不是加拿大，2026-09-24）；两字母州码（CA、DE、IN）与既是州又是国家的 Georgia
 *     说不清是哪一国，不答（dict/workAuthorization.ts）。
 *  4. 答什么：
 *     - 他在那一国有记录 → 按记录答。明确的记录永远优先，包括明确的「否」；UNSPECIFIED 不算答案，交还他。
 *     - 他在那一国没有记录 → 不答（`NO_RECORD`），不论有没有别国记录；浮层说清缺哪一国的记录，不能提供默认答案或预填。
 *       记录没交来（读失败）与交来空清单是两回事，前者不能断言用户没有记录。
 *     页面上还得恰好有一个选项对得上；已有记录的答案也不能猜一个最接近的选项。
 *
 * 清单里的每一条都已经由服务端判过「此刻成立」（未撤销、已生效、未过期），
 * 所以这里不碰时间。
 */
/**
 * 推荐人预填（P1-9）：四道闸——能力位放行、这一栏是推荐人**姓名**（不是邮箱 / 电话 / 关系）、
 * 申请卡片有公司名、用户存的推荐人里恰好一条推荐到这家。全过才预填，且只预填等放行。
 */
function referralPrefill(
  field: ApplyFieldDescriptor,
  label: string,
  options: BuildPlanOptions,
): Readonly<{ name: string; company: string }> | null {
  if (options.capabilities?.['set-referral'] !== true) return null;
  if (!isReferralNameField(label)) return null;
  if (field.kind !== 'text') return null;
  const company = options.jobCompany === undefined ? '' : normalizeCompany(options.jobCompany);
  if (company === '') return null;
  const candidates = (options.referrals ?? []).filter((item) => normalizeCompany(item.company) === company);
  if (candidates.length !== 1) return null;
  const match = candidates[0]!;
  return Object.freeze({ name: match.name, company: match.company });
}

/** 按资料推出来的一道题的答案（`derivedProfileAnswer`）：是非、一段文字，或复选题要勾的几项。 */
type DerivedAnswer = Readonly<{
  key: 'workArrangement' | 'languageAnswer' | 'experienceYears' | 'currentStudent' | 'militaryService' | 'travelAnswer';
  basis: HistoryAnswerBasis;
}> & (
  | Readonly<{ kind: 'yesno'; answer: 'YES' | 'NO' }>
  | Readonly<{ kind: 'text'; value: string }>
  | Readonly<{ kind: 'choices'; values: readonly string[] }>
);

/** 能写一句话的文本框：单行文本或多行框（不是数字、日期、邮箱那一类）。 */
function isProseInput(field: ApplyFieldDescriptor): boolean {
  return (field.kind === 'text' || field.kind === 'textarea') && isFreeTextInput(field.element);
}

/**
 * 按资料推这一题（2026-10-04）；不是这几类、或答不准就 null。各判读自己只认那一类题的整句说法、拒掉掺了别的事的，
 * 所以几道判读之间不会抢同一题：服过兵役吗、现在在读吗、办公方式、语言、出差、工作年限。
 *
 * 写到哪种控件上：是非题在选项控件上选「是／否」那一项，在文本框里写 Yes／No；语言的「列出会说的语言」在复选框组上勾
 * 那几项、在文本框里写语言名；工作年限在文本或数字框里写整年数、在选项控件上选落进的那一档。
 */
function derivedProfileAnswer(
  field: ApplyFieldDescriptor,
  label: string,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
  options: BuildPlanOptions,
): DerivedAnswer | null {
  if (field.kind === 'unsupported' || field.kind === 'file' || field.kind === 'richtext') return null;
  const yesNoControl = isOptionControl(field) || isProseInput(field);
  const collections = options.collections;
  // 每一类只在它的依据交来了时才去判题面：没有资料的那几类一个正则都不跑（扫描＋计划在每一页每一栏上跑，见
  // apply-injection-budget.test.ts）。
  const hasExperiences = (collections?.experiences?.length ?? 0) > 0;
  const hasEducations = (collections?.educations?.length ?? 0) > 0;
  const hasLanguages = (collections?.languages?.length ?? 0) > 0;
  if (yesNoControl) {
    const military = hasExperiences ? militaryServiceAnswer(label, collections) : null;
    if (military !== null) return { key: 'militaryService', basis: military.basis, kind: 'yesno', answer: military.answer };
    const student = hasEducations && options.today !== undefined ? currentStudentAnswer(label, collections, options.today) : null;
    if (student !== null) return { key: 'currentStudent', basis: student.basis, kind: 'yesno', answer: student.answer };
    const arrangement = resolved.preferredWorkModes
      ? workArrangementAnswer(label, {
          workModes: resolved.preferredWorkModes,
          city: resolved.city,
          region: resolved.addressRegion === undefined ? undefined : subdivisionName(resolved.addressRegion) ?? resolved.addressRegion,
          openToRelocation: resolved.openToRelocation,
          openToRelocationCities: resolved.openToRelocationCities,
        }, options.jobLocation)
      : null;
    if (arrangement !== null) return { key: 'workArrangement', basis: arrangement.basis, kind: 'yesno', answer: arrangement.answer };
    const language = hasLanguages ? languageYesNo(label, collections?.languages) : null;
    if (language !== null) return { key: 'languageAnswer', basis: language.basis, kind: 'yesno', answer: language.answer };
    const travel = travelAnswer(label, options.travelPercentMax);
    if (travel !== null) return { key: 'travelAnswer', basis: travel.basis, kind: 'yesno', answer: travel.answer };
  }
  // 「勾选会说的语言」：只在复选框组上（多选下拉的菜单要点开才有，这一步不做）。
  if (hasLanguages && field.kind === 'choice' && !isSingleChoiceGroup(field.choice)) {
    const chosen = languageOptionsToCheck(label, field.choice.options.map((option) => option.label), collections?.languages);
    if (chosen !== null) return { key: 'languageAnswer', basis: 'LANGUAGES_IN_PROFILE', kind: 'choices', values: chosen };
  }
  // 「英语以外还会哪些语言」写成一句：文本框。
  if (hasLanguages && isProseInput(field)) {
    const list = languageListText(label, collections?.languages);
    if (list !== null) return { key: 'languageAnswer', basis: 'LANGUAGES_IN_PROFILE', kind: 'text', value: list };
  }
  // 不带限定的工作年限：文本或数字框写整年数；单选、下拉选落进的那一档（组合框的菜单要点开才有，不做）。
  const total = hasExperiences && options.today !== undefined ? totalExperienceQuestion(label) : null;
  if (total !== null) {
    const months = experienceMonths(collections?.experiences, options.today, total.fullTimeOnly);
    if (months === null) return null;
    const numeric = (field.kind === 'text' && ['text', '', 'number'].includes((field.element.getAttribute('type') ?? 'text').toLowerCase())) ||
      isProseInput(field);
    if (numeric) {
      const years = wholeYears(months);
      return years === null ? null : { key: 'experienceYears', basis: 'EXPERIENCE_YEARS_FROM_HISTORY', kind: 'text', value: String(years) };
    }
    if (field.kind === 'select' || (field.kind === 'choice' && isSingleChoiceGroup(field.choice))) {
      const option = experienceOption(optionTexts(field), months);
      return option === null ? null : { key: 'experienceYears', basis: 'EXPERIENCE_YEARS_FROM_HISTORY', kind: 'choices', values: [option] };
    }
  }
  return null;
}

/**
 * 把按资料推出来的答案排进计划（与 `pushOptionAnswer` 同一套 fill-first：页面上已经有的不覆盖）。是非题在选项控件上
 * 要页面上恰好一项是「是／否」才写；落不下就返回 false，调用方照原路走。
 */
function pushDerivedAnswer(
  entries: ApplyPlanEntry[],
  skipped: ApplyPlan['skipped'],
  field: ApplyFieldDescriptor,
  derived: DerivedAnswer,
  label: string,
  order: number,
  fillEmptyOnly: boolean,
): boolean {
  if (field.kind === 'unsupported' || field.kind === 'richtext') return false;
  if (derived.kind === 'yesno' && isOptionControl(field)) {
    const answer = optionAnswer(field, derived.answer);
    return answer !== null && pushOptionAnswer(entries, skipped, field, derived.key, label, answer, order, fillEmptyOnly);
  }
  if (derived.kind === 'choices') {
    if (field.kind !== 'choice' && field.kind !== 'select') return false;
    const taken = field.kind === 'choice' ? choiceAlreadyAnswered(field) : readValue(field.element).trim() !== '';
    if (fillEmptyOnly && taken) {
      skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: derived.key, element: field.element, order });
      return true;
    }
    const entry = planEntry(field, derived.key, label, derived.values.join('\n'), order, 1);
    if (entry.kind === 'select') entry.resolvedOptionText = derived.values[0]!;
    entries.push(entry);
    return true;
  }
  if (field.kind !== 'text' && field.kind !== 'textarea') return false;
  const value = derived.kind === 'yesno' ? (derived.answer === 'YES' ? 'Yes' : 'No') : derived.value;
  const max = (field.element as HTMLInputElement | HTMLTextAreaElement).maxLength;
  if (Number.isInteger(max) && max > 0 && value.length > max) return false;
  if (fillEmptyOnly && readValue(field.element).trim() !== '') {
    skipped.push({ label, reason: 'NOT_EMPTY', required: field.required, key: derived.key, element: field.element, order });
    return true;
  }
  entries.push(planEntry(field, derived.key, label, value, order, 1));
  return true;
}

/**
 * 「你现在人在 X 吗」能不能预填。四道都过才算数：
 *
 *  1. 是一道纯粹的居住地问句（掺了搬迁/意愿、或问的是工作许可，都不算）。
 *  2. 档案里有 `addressCountry`。
 *  3. 题目点名的国家**就是**档案里那一个。点名别的国家时交还给用户——我们分不清
 *     「他确实不在那儿」和「这个国名我们没认出来」。
 *  4. 这是一个选择控件，且页面上恰好有一个选项对得上「是」。
 *
 * 第 4 道与 EEO 那条同一个理由：说了「已预填」却没有可勾的选项，用户看到的是一个
 * 点不动的条目，比直接说「这题你自己答」还糟。
 */
function residencePrefill(
  field: ApplyFieldDescriptor,
  label: string,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
): OptionAnswer | null {
  if (!isCurrentResidenceQuestion(label)) return null;
  const country = resolved.addressCountry;
  if (country === undefined || country === '') return null;
  if (residenceRegion(label, country) === null) return null;
  if (!isOptionControl(field)) return null;
  return optionAnswer(field, 'YES');
}

/**
 * 搬迁题按档案答「是」。只答得出「是」：判据在 dict/relocation.ts，掺了工作许可、
 * 搬家费用或「什么时候能搬」的都不归这里管；题目点到的地方必须对上他住的城市／州，
 * 或对上他自己列的搬迁城市（列表为空 = 愿意搬、不限地点）。
 *
 * 第 4 道与 EEO、居住地同一个理由：说了能答却没有可勾的选项，用户看到的是一个
 * 点不动的条目，比直接说「这题你自己答」还糟。
 */
function relocationPrefill(
  field: ApplyFieldDescriptor,
  label: string,
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
  /** 岗位地点原文：题目没写搬去哪儿时，说的就是它（2026-09-24）。 */
  jobLocation: string | undefined,
): OptionAnswer | null {
  if (!answersYesToRelocation(label, {
    city: resolved.city,
    region: resolved.addressRegion === undefined ? undefined : subdivisionName(resolved.addressRegion) ?? resolved.addressRegion,
    openToRelocation: resolved.openToRelocation,
    openToRelocationCities: resolved.openToRelocationCities,
  }, jobLocation)) return null;
  if (!isOptionControl(field)) return null;
  return optionAnswer(field, 'YES');
}

/**
 * 工作授权答案的依据，原样挂到计划条目上：按岗位地点推断出的国家（P1-7）。
 * 答案仍必须来自这个国家的记录，推断国家不等于推断资格。
 */
type WorkAuthorizationBasis = Readonly<{ inferredRegionCode?: string }>;

/**
 * 工作授权题的结论：答得出（`ANSWER`，只按该国记录答）；说得出是哪一国而没有那条记录（`NO_RECORD`，
 * 没有答案或预填）；其余 null（说不出是哪一国、记录说不清、
 * 能力位没开……一律「取决于这个岗位」）。
 */
type WorkAuthorizationVerdict =
  | Readonly<{
      kind: 'ANSWER';
      key: 'workAuthorization' | 'workSponsorship';
      answer: OptionAnswer;
      basis: WorkAuthorizationBasis;
    }>
  | Readonly<{ kind: 'NO_RECORD'; regionCode: string }>;

function workAuthorizationPrefill(
  field: ApplyFieldDescriptor,
  label: string,
  options: BuildPlanOptions,
): WorkAuthorizationVerdict | null {
  const fact = workAuthorizationFact(label, options);
  if (fact === null || fact.kind === 'NO_RECORD') return fact;
  const resolvedAnswer = isOptionControl(field) ? optionAnswer(field, fact.answer) : null;
  if (resolvedAnswer === null) return null;
  return Object.freeze({
    kind: 'ANSWER' as const,
    key: fact.questionKind === 'REQUIRES_SPONSORSHIP' ? 'workSponsorship' : 'workAuthorization',
    answer: resolvedAnswer,
    basis: fact.basis,
  });
}

type WorkAuthorizationFact =
  | Readonly<{ kind: 'FACT'; questionKind: WorkAuthorizationQuestionKind; answer: 'YES' | 'NO'; basis: WorkAuthorizationBasis }>
  | Readonly<{ kind: 'NO_RECORD'; regionCode: string }>;

/**
 * 工作授权题该答的是／否（四道筛见上面「工作授权／担保能不能预填」那段）：按记录答；说得出是哪一国、他在那一国
 * 没有该国记录时是 `NO_RECORD`，绝不从别国记录推资格；答不出就 null。
 */
function workAuthorizationFact(
  label: string,
  options: BuildPlanOptions,
): WorkAuthorizationFact | null {
  if (options.capabilities?.['set-work-authorization'] !== true) return null;
  const kind = workAuthorizationQuestionKind(label);
  if (kind === null) return null;
  // 记录没交来（读失败）与交来了一个空清单是两回事：前者不知道他有没有记录，「没有记录」那句话不能说，
  // 读失败时不能断言没有该国记录；任何情况都不生成默认答案。
  const delivered = options.workAuthorizations !== undefined;
  const authorizations = options.workAuthorizations ?? [];
  const regions = authorizations.map((item) => item.regionCode.trim().toUpperCase());
  const named = namedWorkRegion(label, regions);
  // 题目点名了地方就只认点名的那个（点名了日本、用户只有美国记录 → 按日本说，不拿美国那条顶替）；一个地方都没提
  // （「the country in which this role is located」「to work at Cloudflare」）才按岗位地点推（P1-7），
  // 并把「这是推断」带出去。问的是「你现在住的国家」的不推：岗位国家不是那道题的答案。
  const inferred = named === null && options.jobRegionCode !== undefined && !mentionsAnyRegion(label) &&
      !refersToResidence(label)
    ? options.jobRegionCode.trim().toUpperCase()
    : null;
  const region = named ?? inferred;
  if (region === null) {
    // 题目点名的地方恰好解出一国、而用户在那一国没有记录：说得出是哪一国，才算「没有记录」。两字母的州／省码在这里
    // 也不认（与 namedWorkRegion 同一个口径，2026-09-24）：题面上的 CA、DE、IN 说不清是州还是加拿大、德国、印度。
    // 解出的那一国**有**记录（写的是「USA」这类 namedWorkRegion 不认的别名）时照旧不答。
    const mentioned = delivered && mentionsAnyRegion(label) && !refersToResidence(label) ? inferRegionCode(label, false) : null;
    return mentioned !== null && !regions.includes(mentioned) ? withoutRecord(mentioned) : null;
  }
  const basis: WorkAuthorizationBasis = inferred === null ? {} : { inferredRegionCode: inferred };
  const record = authorizations.find((item) => item.regionCode.trim().toUpperCase() === region);
  if (record === undefined) return delivered ? withoutRecord(region) : null;
  const answer = kind === 'AUTHORIZED_TO_WORK' ? record.authorizedToWork
    : kind === 'REQUIRES_SPONSORSHIP' ? record.requiresSponsorship
    : withoutSponsorshipAnswer(record);
  if (answer !== 'YES' && answer !== 'NO') return null;
  return { kind: 'FACT', questionKind: kind, answer, basis };
}

/** 缺该国记录：不论其他国家有多少记录，都不能生成答案或预填。 */
function withoutRecord(region: string): WorkAuthorizationFact {
  return { kind: 'NO_RECORD', regionCode: region };
}

/**
 * 「年满 18 且有权在 X 工作吗」（2026-09-24）：答案是两半的合取，两半各有各的依据。
 *
 *  - 明确未满 18（档案 over18 = false）→ 否，键 over18：只凭年龄就确定，不涉及工作授权；
 *  - 那国的授权记录是「否」→ 否，键 workAuthorization（与单独问授权时同一套筛：能力位、记录、点名或按岗位地点推）；
 *  - 年满 18（明确的，或档案里没有明确值时按学历／工作经历推出来的）∧ 授权是「是」→ 是，键 workAuthorization。
 *    授权的「是」只能来自该国明确记录；别国的记录不能补出这半句。
 *  - 其余答不了，交还用户（年龄那一半没有依据、他一条记录都没有……）。
 */
function ageAndWorkAuthorizationAnswer(
  label: string,
  over18: string | undefined,
  adultByHistory: boolean,
  options: BuildPlanOptions,
): Readonly<{ key: 'over18' | 'workAuthorization'; answer: 'YES' | 'NO'; fromHistory?: true; basis?: WorkAuthorizationBasis }> | null {
  if (!asksAgeAndWorkAuthorization(label)) return null;
  if (over18 === 'false') return { key: 'over18', answer: 'NO' };
  const fact = workAuthorizationFact(label, options);
  // 说得出是哪一国、他一条记录都没有（NO_RECORD）在这道合起来的题上也答不了：交还用户。
  if (fact === null || fact.kind === 'NO_RECORD' || fact.questionKind === 'REQUIRES_SPONSORSHIP') return null;
  const { basis } = fact;
  if (fact.answer === 'NO') return { key: 'workAuthorization', answer: 'NO', basis };
  if (over18 === 'true') return { key: 'workAuthorization', answer: 'YES', basis };
  return over18 === undefined && adultByHistory ? { key: 'workAuthorization', answer: 'YES', fromHistory: true, basis } : null;
}

/**
 * over18 这一题该写的值（`ageQuestion` 判过问的是哪一边）：年满那一边照档案值（没有明确值时用推出来的「年满 18」），
 * 未满那一边答它的反面。给不出来就把 over18 从这一题的档案视图里拿掉，后面照常落「没有值」。
 */
function withAgeAnswer(
  resolved: Readonly<Partial<Record<ApplyFieldKey, string>>>,
  age: AgeQuestion,
  adultByHistory: boolean,
): Readonly<Partial<Record<ApplyFieldKey, string>>> {
  const own = resolved.over18 ?? (adultByHistory ? 'true' : undefined);
  // WORKING_AGE 与年满那一边同样照 own 答：可写的控件上明确未满 18 的在主循环里就交还了，写得进去的只有「是」或没有值
  // （不可写的控件照旧按 unsupported 交还，用不到这个值）。
  const value = age !== 'UNDER_18' ? own : own === 'true' ? 'false' : own === 'false' ? 'true' : undefined;
  if (value === resolved.over18) return resolved;
  const { over18: _replaced, ...rest } = resolved;
  return value === undefined ? rest : { ...rest, over18: value };
}

/**
 * 「不需要担保就有权工作吗」的答案：两项记录一起决定。
 *
 * 有权工作且不需要担保 → YES；无权工作、或需要担保（离开担保就不能工作）→ NO；
 * 缺了哪一项说不清 → null，交还用户。
 */
function withoutSponsorshipAnswer(
  record: Readonly<{ authorizedToWork: string; requiresSponsorship: string }>,
): 'YES' | 'NO' | null {
  if (record.authorizedToWork === 'NO' || record.requiresSponsorship === 'YES') return 'NO';
  if (record.authorizedToWork === 'YES' && record.requiresSponsorship === 'NO') return 'YES';
  return null;
}
