/**
 * Field-level safety guards shared by future matching and click policy code.
 *
 * These functions intentionally consume plain text rather than DOM nodes. That
 * keeps the policy unit-testable and prevents vendor-specific selectors from
 * leaking out of `parsers/<vendor>/`.
 */

/** Names that describe somebody other than the applicant. */
/**
 * `team member` 是 2026-09-17 从 352 个真实申请页量出来补的：合投／团队申请表上
 * 有「Team member 2 first and last name」「Team member 2 email address」这类栏，
 * 此前一条守卫都不中，标签匹配会把**申请人自己的**姓名与邮箱写进队友那一栏。
 */
export const OTHER_PERSON =
  /emergency|\breferees?\b|guarantor|guardian|spouse|beneficiary|next of kin|紧急联系|担保人|推荐人|亲属|配偶/i;

/**
 * 这几个词也常出现在**问申请人自己**的题里（2026-09-23 同页对比实测）：「How comfortable are you
 * mentoring other team members…」「Years of experience relative to this role」「Have you worked as a
 * supervisor?」。所以它们只在两种情形下算「涉及他人」：标签很短（「Reference」「Supervisor」），或同时
 * 要对方的资料（姓名、邮箱、电话、公司、关系……）。`reference` 要词边界：「Location preference」里就含
 * 着它，从前偏好题一律被当成他人信息拦掉。
 */
const OTHER_PERSON_CONTEXTUAL = /\breferences?\b|\brelatives?\b|\bsupervisors?\b|\bteam ?members?\b|团队成员/i;
const OTHER_PERSON_DETAIL =
  /\bname\b|e-?mail|phone|mobile|contact|relationship|\btitle\b|company|employer|organi[sz]ation|address|\bknown\b|姓名|名字|邮箱|电话|联系方式|关系|职位|单位|公司/i;
const SHORT_LABEL_WORDS = 4;

/** Phone-adjacent metadata that must not receive the applicant's phone number. */
export const PHONE_GUARD = /extension|\bext\b|device|type|country ?code|area ?code|分机|区号/i;

/** Calling-code controls are not country selectors. */
export const COUNTRY_GUARD = /\bcode\b|phone|calling|dial/i;

/**
 * The control that owns the number's **country calling code**, when the form
 * carries one of its own.
 *
 * 2026-09-15 实测（nvidia.wd5.myworkdayjobs.com 的 My Information）：
 * 「Country Phone Code」是一个独立必填控件，开箱就选好了 `United States of
 * America (+1)`；此时把档案里的 `+1 415 555 0142` 整串写进「Phone Number」，
 * 宿主判 `Enter a valid format for Phone Number` —— 号码进去了、看着填了，
 * 提交时整页被自己的校验挡住。带自有区号控件的表单要的是**国内号段**。
 *
 * 与 `PHONE_GUARD` 的分工：那一条回答「这一栏能不能收整串号码」（分机/区号/
 * 设备类型一律不能），这一条回答「这张表自己管不管国际区号」——命中它的控件
 * 存在，就说明电话栏只该收国内号段。两者都窄口径：宁可漏判（退回今天的整串
 * 写入）也不要误判把 `Postal Code` / `Area Code` 当成国际区号控件。
 */
export const PHONE_COUNTRY_CODE =
  /\b(?:country|international)\s*(?:phone|tel(?:ephone)?|mobile|calling|dial(?:l?ing)?)\s*code\b|\b(?:phone|tel(?:ephone)?|mobile)\s*country\s*code\b|\b(?:calling|dial(?:l?ing)?)\s*code\b|国家区号|国际区号|电话区号/i;

/**
 * 答案是 **f(候选人 × 岗位)** 而不是 f(候选人) 的问题。
 *
 * 同一个人投美国岗和英国岗，"是否需要签证担保"的答案可能相反；期望薪资对初级岗和
 * 高级岗也不是同一个数。把这类问题的答案存进档案，等于诱导用户存一个**在一半岗位上
 * 是错的**答案，而且它们多半是 knockout 题——答错直接出局，用户还看不出为什么。
 *
 * 所以它与 `LOW_CONFIDENCE`（我们的能力不足）语义完全不同，必须分开报：前者是
 * "这题只能你自己答"，后者是"我们没认出来"。合并会让用户以为多等一个版本就好了。
 *
 * 每一条都刻意收窄，宁可漏判也不要误判：
 * - 到岗时间只认"什么时候能开始/通知期"这类问法，**不认**光秃秃的 "start date"
 *   —— 教育与工作经历每一段都有 start date，误判会让用户看到一堆莫名其妙的
 *   "这题取决于具体岗位"。
 * - 搬迁只认 relocate/relocation，不碰 location（那是我们的档案键之一）。
 */
export const JOB_DEPENDENT =
  /\b(?:work(?:ing)? authori[sz]|authori[sz](?:ed|ation) to work|right to work|work rights|legally (?:authori[sz]|entitled|eligible)|require .{0,20}sponsor|sponsorship|visa status|work permit|h-?1b|opt\b|cpt\b)|\brelocat(?:e|ion)\b|\b(?:expected|desired|target)\s+(?:salary|compensation|pay)\b|\bsalary\s+(?:expectation|requirement)|compensation\s+expectation|\bnotice period\b|when can you start|available (?:to )?start|earliest .{0,15}start|工作授权|需要.{0,4}签证|签证担保|工作许可|是否愿意搬迁|期望薪[资酬]|薪资期望|到岗时间|最早.{0,4}入职|入职时间|离职通知期/i;

/**
 * Hidden trap fields used to distinguish automated form fillers.
 *
 * ⚠️ 这是**最危险的失效模式**，比"填不上"严重一个数量级：填进蜜罐 → 整份申请
 * 被静默标记为 bot 流量丢弃 → 用户端零报错，永远不知道自己为什么没有回音。
 *
 * Workday 官方在登录/注册表单里埋了 `data-automation-id="beecatcher"`，label 是
 *   "Enter website. This input is for robots only, do not enter if you're human."
 * 它有三处专门针对常规检测的设计：
 *   ① 文案说 "do not **enter**" 而不是 "do not fill" —— 旧正则只认后者，实测漏过；
 *   ② **有** label、tabindex 正常、`display:block; visibility:visible; opacity:1`
 *      —— "无 label + 离屏 + tabindex=-1" 那套启发式三条全不中；
 *   ③ 藏身靠 `position:absolute + clip:rect(1px,1px,1px,1px)`，`getBoundingClientRect`
 *      返回的是布局尺寸不是裁剪尺寸，所以 isVisible() 类检查全部通过。
 * 最阴险的是 label 叫 "Enter website" —— **正好命中我们自己的 portfolioUrl 同义词**
 * `/(portfolio|personal (web)?site|website)/i`，通用引擎会主动把用户真实网址填进去。
 *
 * 因此防线必须是三层（文案 / 属性身份 / 几何），任何一层命中即拒。
 */
export const HONEYPOT =
  /leave (this|the)?\s*(field|box)?\s*blank|请将此栏留空|留空|do ?n['o]?t (fill|enter|complete)|for robots only|are you human|spam.?bot|机器人/i;

/**
 * Attribute-identity blacklist. Checked against `name` / `id` / `class` /
 * `data-automation-id` / `data-ui` / `data-qa` — the hooks vendors actually use.
 * `beecatcher` is Workday's; the rest are the common open-source spellings.
 */
export const HONEYPOT_IDENTITY =
  /bee[-_ ]?catcher|honey[-_ ]?pot|bot[-_ ]?trap|spam[-_ ]?trap|no[-_ ]?fill|gotcha/i;

/**
 * Current runtime hard deny for password controls. The pending L2-P proposal
 * does not weaken this generic path: any future password write must use a
 * separate origin-bound local credential authority plus durable per-occurrence
 * release. Until that final convergence is approved and released, passwords
 * are never read, stored, planned, or filled here.
 */
export const PASSWORD_DENY = /^(choose |retype |confirm )?password$|密码/i;

/**
 * Normalise label-like text without erasing words used by the regular
 * expressions above. Required markers and a trailing colon are presentation
 * only, so they must not make an otherwise exact password guard miss.
 */
export function normalizeGuardText(value: string): string {
  return value
    .normalize('NFKC')
    // 变体选择符先单独去掉，再匹配符号本身。
    //
    // 从前这里是一个类：`[*✱✦※•·❋✳︎✴︎✷✸]`。那里的 `✳︎` / `✴︎` 各是**两个码点**
    // （基字 + U+FE0E），在字符类里等于把基字和选择符各列了一次——看起来像一个
    // 符号、实际是两个；而且只要它们在类里相邻，eslint 的
    // no-misleading-character-class 就一直判红（argoland vendored 这一支之后
    // 撞上的就是它）。
    //
    // 拆成两步之后集合没变，还更准一点：孤立的变体选择符从前会被换成空格，
    // 现在直接删掉——它本来就不占宽度，换成空格是把一个看不见的东西变成一个
    // 看得见的间隔。
    .replace(/[\uFE0E\uFE0F]/gu, '')
    .replace(/[*✱✦※•·❋✳✴✷✸]+/gu, ' ')
    .replace(/[：:]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function matches(pattern: RegExp, value: string): boolean {
  // Future callers may provide a global RegExp. Resetting makes this helper
  // deterministic even then; the exported guards currently are not global.
  pattern.lastIndex = 0;
  return pattern.test(normalizeGuardText(value));
}

/**
 * 说的不是另一个人的两种写法（2026-09-24 adobe.wd5 第 3 页）：括号里的举例（e.g. / such as / for example / including），
 * 以及「配偶签证」这类签证类型。「Will you … require sponsorship for employment visa status (e.g., H-1B visa status, spouse
 * visa, etc)?」问的是申请人自己，从前因为一个 spouse 整道被当成「涉及他人」跳过。去掉之后再判：「Emergency contact (e.g.,
 * spouse or parent)」照旧是紧急联系人，「Name of spouse (if any)」的括号不是举例、照旧拦。
 */
const NOT_ANOTHER_PERSON =
  /\((?:e\.?\s?g\.?|i\.?\s?e\.?|such as|for example|for instance|including)[^)]*\)|\bspous(?:e|al)(?:['’]s)?\s+(?:visa|work permit|permit|status|ead)\b/giu;

export function isOtherPersonField(value: string): boolean {
  const subject = value.normalize('NFKC').replace(NOT_ANOTHER_PERSON, ' ');
  if (matches(OTHER_PERSON, subject)) return true;
  if (!matches(OTHER_PERSON_CONTEXTUAL, subject)) return false;
  const words = normalizeGuardText(subject).replace(/[*:?()]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length <= SHORT_LABEL_WORDS || matches(OTHER_PERSON_DETAIL, subject);
}

/**
 * 推荐人（P1-9）：他人信息里唯一有可信数据源的子类——用户亲手存的「谁把我推荐到哪家」。
 * 只认「推荐 / referral / referred by / who referred you」这一族；证明人（reference / referee）、
 * 紧急联系人、配偶等仍归 OTHER_PERSON。命中这一族的栏一律先走推荐人分支：没有可用的记录就按
 * OTHER_PERSON 跳过——从前 "Referred by" 不在 OTHER_PERSON 里，会按标签把申请人自己的名字写进去。
 */
export const REFERRAL = /\breferr(?:al|ed|er|ing)\b|\bwho referred\b|推荐人|内推/i;

export function isReferralField(value: string): boolean {
  return matches(REFERRAL, value);
}

/** 推荐人栏里只有**姓名**那一栏会被预填；邮箱、电话、关系、职位一律不代填（只开姓名是产品决定）。 */
const REFERRAL_CONTACT_DETAIL = /e-?mail|phone|mobile|\btel\b|relationship|\btitle\b|department|employee ?id|邮箱|电话|关系|职位|工号/i;

export function isReferralNameField(value: string): boolean {
  return isReferralField(value) && !matches(REFERRAL_CONTACT_DETAIL, value);
}

export function isPhoneMetaField(value: string): boolean {
  return matches(PHONE_GUARD, value);
}

export function isCountryCodeField(value: string): boolean {
  return matches(COUNTRY_GUARD, value);
}

/** 这张表自己有国际区号控件吗？见 `PHONE_COUNTRY_CODE`。 */
export function isPhoneCountryCodeField(value: string): boolean {
  return matches(PHONE_COUNTRY_CODE, value);
}

/**
 * 这个文件控件是**简历**吗？
 *
 * 一张申请表上常常不止一个 `<input type="file">`：求职信、成绩单、作品集、
 * 推荐信。把简历挂到"成绩单"那一栏，比不挂糟得多——recruiter 会看到一份
 * 明显不对的附件，而用户以为自己传对了。
 *
 * 所以判据是**正向白名单**，认不出就不填。`curriculum vitae` 与中日文写法一并覆盖：
 * 实测 Lever 的标签是 "Resume/CV ✱ATTACH RESUME/CV…"。
 */
/**
 * ⚠️ 重音在**第一个** e 上：`Résumé`。原来写的是 `\bresum[eé]\b`，它匹配不到
 * `ré`——2026-08-23 被 Rippling 真实页面戳穿（那一家的标签就是 `Résumé`）。
 *
 * 尾部用 `(?!\p{L})` 而不是 `\b`：`\b` 是 ASCII 语义，`é` 在它眼里是非单词字符，
 * 所以 `\b` 结尾对 `résumé` 永远不成立。
 */
/**
 * 2026-09-28 通用路：德文「Lebenslauf」（Hetzner 的必填上传栏）、西文／葡文「Currículum」「Currículo」「Hoja de vida」。
 * 法文就是「CV」，原来就认。
 */
export const RESUME_FILE = /\br[ée]sum[eé](?!\p{L})|\bcv\b|curriculum ?vitae|\bcurr[íi]cul(?:um|o)(?!\p{L})|lebenslauf|hoja de vida|简历|履歴書|이력서/iu;

/** Explicitly different uploads win over a stale `id="resume"` identity. */
export const NON_RESUME_FILE =
  // `autofill` 是 2026-08-23 从 Dover 实测加的：那一家的申请表上有两个 .pdf 文件栏，
  // 第一个是厂商自己的简历解析器（文案 `Autofill from resume`），传上去是回填表单不是附件；
  // 真正的附件栏文案里反而一个 resume 字都没有。不排掉它，正向白名单会正好挑中假的。
  // 2026-09-28 通用路：德文、法文、西文的求职信、成绩／证书、照片（Hetzner 的「Anschreiben」「letztes Schulzeugnis」「Foto」）。
  /cover[-_\s]*letter|transcript|portfolio|work[-_\s]*sample|reference|recommendation|certificate|photo|avatar|auto[-_\s]?fill|anschreiben|motivationsschreiben|bewerbungsschreiben|zeugnis|\bfoto\b|lichtbild|lettre[-_\s]*de[-_\s]*motivation|relev[ée]s?[-_\s]*de[-_\s]*notes|dipl[ôo]me|carta[-_\s]*de[-_\s]*(?:presentaci[óo]n|motivaci[óo]n)|certificad[oa]|求职信|成绩单|作品集|推荐信|证书|照片|头像|写真/i;

/**
 * Exact positive identity; arbitrary long answers must never receive it.
 *
 * 仍是锚定的整句（作文题、「你有没有求职信」这类问句永远不算）。2026-09-27 起多认几种写法：
 * 「(optional)」一类的括注、Motivation letter / Letter of motivation、「Cover letter / Motivation letter」这种并列。
 */
export const COVER_LETTER_FIELD =
  /^(?:cover[-_ ]?letter|covering[-_ ]?letter|application[-_ ]?letter|motivation(?:al)?[-_ ]?letter|letter[-_ ]of[-_ ]motivation|anschreiben|motivationsschreiben|bewerbungsschreiben|lettre[-_ ]de[-_ ]motivation|carta[-_ ]de[-_ ](?:presentaci[óo]n|motivaci[óo]n)|求职信|応募書類)(?:\s*(?:\/|or)\s*(?:cover[-_ ]?letter|motivation(?:al)?[-_ ]?letter|letter[-_ ]of[-_ ]motivation))?(?:\s*\((?:optional|required|recommended|if applicable)\))?$/iu;

/**
 * 占位符与提示句里的求职信（2026-09-27）：Jobvite「Type or paste your Cover Letter here」、Lever 那一栏
 * 「Additional information」的占位符「Add a cover letter or anything else you want to share.」。同样锚定整句：
 * 只认「写／贴／加一封求职信（在这里）」，问句与说明文字不算。
 */
export const COVER_LETTER_PROMPT =
  /^(?:please\s+)?(?:type|paste|enter|write|add|insert)(?:\s+(?:or|and|\/)\s+(?:type|paste|enter|write|add|insert))?\s+(?:(?:a|your|the)\s+)?cover[-_ ]?letter(?:\s+(?:here|below))?(?:\s+or\s+anything\s+else\s+(?:you(?:['’]d)?\s+(?:want|like)|you\s+would\s+like)\s+to\s+(?:share|add|include)(?:\s+with\s+us)?)?\.?$/iu;

function isCoverLetterText(value: string): boolean {
  return matches(COVER_LETTER_FIELD, value) || matches(COVER_LETTER_PROMPT, value);
}

export function isCoverLetterField(
  value: string,
  identities: ReadonlyArray<string | null | undefined> = [],
): boolean {
  if (isCoverLetterText(value)) return true;
  return identities.some((identity) => (identity ? isCoverLetterText(identity) : false));
}

/**
 * 求职信上传栏的正向身份（2026-09-27）。不锚定：上传栏的标签常是「Upload cover letter」「Cover Letter (PDF)」，
 * 稳定钩子是 `cover_letter` 一类。与简历互斥——同一栏同时说到简历（「Resume or cover letter (one file)」）就两样
 * 都不给，交还本人；说到别的附件（成绩单、作品集……）也不算。
 */
export const COVER_LETTER_FILE =
  /cover[-_\s]*letter|covering[-_\s]*letter|motivation(?:al)?[-_\s]*letter|letter[-_\s]*of[-_\s]*motivation|anschreiben|motivationsschreiben|bewerbungsschreiben|lettre[-_\s]*de[-_\s]*motivation|carta[-_\s]*de[-_\s]*(?:presentaci[óo]n|motivaci[óo]n)|求职信/iu;
/** 求职信上传栏上说到的别的附件（简历另判）。 */
const NON_COVER_LETTER_FILE =
  /transcript|portfolio|work[-_\s]*sample|writing[-_\s]*sample|reference|recommendation|certificate|photo|avatar|auto[-_\s]?fill|other[-_\s]*(?:attachment|document|file)s?|zeugnis|\bfoto\b|lichtbild|relev[ée]s?[-_\s]*de[-_\s]*notes|dipl[ôo]me|certificad[oa]|成绩单|作品集|推荐信|证书|照片|头像|写真/iu;

export function isCoverLetterFileField(
  value: string,
  identities: ReadonlyArray<string | null | undefined> = [],
): boolean {
  const texts = [value, ...identities].filter((text): text is string => typeof text === 'string' && text !== '');
  if (!texts.some((text) => matches(COVER_LETTER_FILE, text))) return false;
  return !texts.some((text) => matches(RESUME_FILE, text) || matches(NON_COVER_LETTER_FILE, text));
}

/** 只作否决：这段文字说到了简历或别的附件（求职信栏的邻近上下文用它，见 setFile）。 */
export function namesNonCoverLetterUpload(value: string): boolean {
  return matches(RESUME_FILE, value) || matches(NON_COVER_LETTER_FILE, value);
}

/**
 * ⚠️ **必须同时看属性身份，光看标签会漏掉最主流的一家。**
 *
 * 实测 2026-08-01：Greenhouse 的简历控件标签就是 `"Attach"`（不含 resume/cv），
 * 但它的 `id` 是 `resume`。只按标签判会让 Greenhouse 的简历上传**永远不触发**，
 * 而且完全静默——面板显示"需手动填"，看起来像我们不支持这个控件。
 *
 * 与蜜罐守卫同一形状：文案一层、属性身份一层，任一命中即算。
 */
export function isResumeFileField(
  value: string,
  identities: ReadonlyArray<string | null | undefined> = [],
): boolean {
  if (matches(RESUME_FILE, value)) return true;
  return identities.some((identity) => (identity ? matches(RESUME_FILE, identity) : false));
}

export function isNonResumeFileField(
  value: string,
  identities: ReadonlyArray<string | null | undefined> = [],
): boolean {
  if (matches(NON_RESUME_FILE, value)) return true;
  return identities.some((identity) => (identity ? matches(NON_RESUME_FILE, identity) : false));
}

export function isJobDependentField(value: string): boolean {
  return matches(JOB_DEPENDENT, value);
}

export function isHoneyPotField(value: string): boolean {
  return matches(HONEYPOT, value);
}

/**
 * Second line: the control's own attribute hooks. Callers pass whatever they
 * read off the element (`name`, `id`, `class`, `data-automation-id`,
 * `data-ui`, `data-qa`); anything absent is simply skipped.
 */
export function isHoneypotIdentity(values: ReadonlyArray<string | null | undefined>): boolean {
  return values.some((value) => (value ? matches(HONEYPOT_IDENTITY, value) : false));
}

/**
 * Third line: the geometry a trap uses to hide from humans while staying
 * "visible" to `visibility`/`opacity`/`display` checks.
 *
 * Deliberately a plain struct rather than an Element — the caller reads the
 * DOM, this module stays pure and unit-testable (see the file header).
 */
export interface HoneypotGeometry {
  /** `getBoundingClientRect()` — note this is the LAYOUT box, not the clipped box. */
  readonly width: number;
  readonly height: number;
  /** Computed `clip` and `clip-path`; Workday hides beecatcher with clip:rect(1px…). */
  readonly clip?: string;
  readonly clipPath?: string;
  /** Computed `font-size` in px. */
  readonly fontSize?: number;
  /**
   * `getBoundingClientRect()` 的横向两边（**视口相对**）。
   *
   * 2026-08-23 从 BambooHR 实测加的：那一家的蜜罐尺寸完全正常（178×28）、
   * clip 与字号都干净，藏法是把**父节点** `position:absolute; left:-9999px`
   * 推出视口。上面三条判据一条都够不着，最后是靠文案层（label 逐字是
   * `Please leave this field blank`）单点接住的 —— 而下一家未必好心给个 label。
   *
   * **只收横向**。纵向不收是有意的：`top` 是视口相对的，页面往下滚一点，
   * 上面的字段 `top` 就是负数，那完全正常。
   */
  readonly left?: number;
  readonly right?: number;
}

/**
 * 「整体在左侧视口外」的距离门槛。
 *
 * 取 1000px 而不是 0：要求整体出界（`right <= 0`）**且出得很远**。
 * 表单里的真实字段被横向推出去一千像素以上，实际不会发生；
 * 而 `-9999px` 是这一招的教科书写法。
 *
 * 误判方向是安全的：多判一次只是那一栏如实报「需手动填」，
 * 漏判一次是整份申请被站点静默丢弃。
 */
const OFFSCREEN_LEFT_PX = -1000;

/** A 1px (or smaller) clip rectangle is the sr-only / bot-trap signature. */
const TINY_CLIP = /rect\(\s*0?\.?\d*p?x?[, ]+\s*0?\.?\d*p?x?[, ]+\s*0?\.?\d*p?x?[, ]+\s*0?\.?\d*p?x?\s*\)/;

function isTinyClip(value: string | undefined): boolean {
  if (!value || value === 'auto' || value === 'none') return false;
  const numbers = [...value.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => Number(m[1]));
  if (numbers.length === 0) return TINY_CLIP.test(value);
  // rect(top, right, bottom, left): a 1px window means every offset is ≤ 1px.
  return numbers.every((n) => Math.abs(n) <= 1);
}

export function isHoneypotGeometry(geometry: HoneypotGeometry): boolean {
  if (geometry.width <= 1 || geometry.height <= 1) return true;
  if (geometry.fontSize !== undefined && geometry.fontSize <= 0) return true;
  // 整体推到左侧视口外很远——见 `OFFSCREEN_LEFT_PX` 与 `left`/`right` 的头注。
  // 两个坐标都拿到才判：只给一个说明调用方的采集不完整，那时不猜。
  if (
    geometry.left !== undefined &&
    geometry.right !== undefined &&
    geometry.left <= OFFSCREEN_LEFT_PX &&
    geometry.right <= 0
  ) {
    return true;
  }
  return isTinyClip(geometry.clip) || isTinyClip(geometry.clipPath);
}

export function isPasswordField(value: string): boolean {
  return matches(PASSWORD_DENY, value);
}

/**
 * 当前 production fail-closed 守卫覆盖四类：**EEO 自我认同、全部法律声明、密码、验证码**。
 * 三道生产闸未解除前，它们都由用户本人操作；这描述的是当前 runtime，不是把四类永久
 * 归成同一产品语义。验证码／2FA／人机验证、营销订阅、联系现任雇主以及未列明／混合授权
 * 始终由用户本人完成；密码、背景调查、仲裁与信用／药检授权则是 default-off 的
 * `PENDING_L2P_PROPOSAL` 候选，在 final-head 批准、durable per-item release、origin-bound
 * local credential authority 与 fresh revalidation 全链闭合前仍由本守卫拒绝。EEO、工作授权与
 * 「信息属实」声明只允许在 Profile 明确值 + 逐次阻塞确认下进入既有乙档。
 *
 * ⚠️ **2026-08-18 之前这四类在填表链路上一道守卫都没有**（体检发现）：
 * `engine.ts` 的守卫链只有蜜罐 / 推荐人 / JOB_DEPENDENT 三道；
 * `isPasswordField` 与名字就叫「永不自动填」的 `mustNeverAutofill` 在 `src/` 下
 * **零调用方**；`LEGAL_DECLARATION` / `OTP_OR_VERIFICATION` 的正则只活在
 * `click/policy.ts`，而那条路径只被 combobox 下拉点击用，**管不到 setValue /
 * setFile 的写入链**。
 *
 * 密码今天之所以没被填，只是因为 `dict/controls.ts` 的 `TEXTUAL_INPUT_TYPES`
 * 白名单**碰巧没有** `'password'`——实测把它加进去，570 + 129 条用例全绿。
 * 也就是说：**没有任何测试写着「密码不许填」**。
 *
 * 更近的风险是 choice 写入（数据源就位后必然做）：一旦接上，EEO 人口统计单选与
 * 「I certify…」法律勾选会直接通过全部旧守卫被代勾。现有分类器因此必须继续
 * fail closed，直到乙档源契约、阻塞确认与 capability gate 全部落地。
 *
 * 2026-09-17 补 hispanic/latino：EEO-1 把族裔与种族分成两问，于是申请表上有
 * 「Are you Hispanic/Latino?」这种把族裔单拎出来的是否题（352 页实测 5 次）。
 * 原正则只有 race/ethnicity，这类题一条都不中——不是被误填，是压根没被认成
 * 自我认同题，直接掉到「这个下拉我们没数据」那一档，用户看到的理由也是错的。
 *
 * 本判据是**文案层**。与蜜罐一样，单层不够——但四类里有三类（密码/验证码/法律
 * 声明）的文案高度定型，EEO 更是法定措辞（EEO-1 七类、CC-305 恰好三项、
 * VEVRAA 四类），文案层的召回率在这里远高于蜜罐那种对抗性场景。
 */
export const SELF_IDENTIFICATION =
  /\b(eeo|equal opportunity|self[- ]?identif|voluntary (self[- ]?)?disclos|demographic)\b|\bgender\b|\brace\b|\bethnicit|\bhispanic\b|\blatin[ox]\b|\bveteran\b|\bdisabilit|\blgbtq|\bsexual orientation\b|\btransgender\b|性别|种族|族裔|拉美裔|退伍|残疾|残障|性取向/i;

/**
 * 作文 / 开放题：只有用户本人能答（P4-15）。
 *
 * 认不出档案键的控件从前一律报 LOW_CONFIDENCE（「没把握，没敢填」），而这类题根本不是「我们没认出来」：
 * Why us / Tell us about / Describe / Additional information 的答案不在任何档案键里。说成没把握，用户会
 * 等下个版本；说成「只有你能答」，他才会去答——或者让 AI 起草（P3-13 只对这类 textarea 出按钮）。
 * 只在 **textarea** 上判：单行文本框上的 "why" 多半是别的东西（"Why did you leave" 也是作文，但它在
 * 经历段里、有自己的键）。
 */
export const OPEN_QUESTION =
  /\bwhy (do|would|are|did) you\b|\bwhy us\b|\btell us (about|more|a little)\b|\bdescribe\b|\badditional (information|comments|details|context)\b|\banything else\b|\bin your own words\b|\bwhat (interests|excites|motivates|draws) you\b|\bwhat makes you\b|\bwalk us through\b|为什么|请描述|请介绍|补充说明|其他信息|其他补充|自我介绍|谈谈/i;

/**
 * 与这家公司的历史：是否在这里工作过 / 申请过 / 面试过——只有用户知道，档案里没有。
 * 单行文本、下拉、复选都可能问，所以不限控件种类。「有没有亲友在职」不在这里：它先被
 * OTHER_PERSON 守卫接走（涉及他人，静默跳过），引擎到不了这条。
 */
export const COMPANY_HISTORY =
  /\b(previously|ever|before|formerly)\b[^.?]{0,40}\b(worked|employed|applied|interviewed|interned|contracted)\b|\b(worked|employed|applied|interviewed|interned)\b[^.?]{0,40}\b(previously|before|in the past|here)\b|\b(current|former|previous) (employee|contractor|intern)\b|\bknow anyone (who works|at)\b|曾(经)?(在|向)[^。？]{0,12}(工作|任职|实习|申请|面试)|是否[^。？]{0,10}(申请|面试|任职|工作)过/i;

/**
 * 某个平台上的用户名／账号名（"What's your Discord username?"、"Slack handle"）：答案是用户在
 * 别处的身份，档案里没有这一栏，也不该猜。2026-09-21 Discord 页实测它报成「没把握，没敢填」。
 * GitHub / LinkedIn 一类通常已被规则认成链接键，到不了这里；到了这里就也是只有他能答。
 */
export const PERSONAL_HANDLE =
  /\b(user ?name|handle|screen ?name|gamer ?tag)\b|\b(discord|slack|telegram|skype|wechat|whatsapp|steam|twitch|instagram|tiktok)\b[^.?]{0,20}\b(id|name|account)\b|用户名|账号名|昵称/i;

/** 这道题是不是只有用户本人能答（作文只看 textarea；公司历史与用户名不限控件）。 */
export function isUserOnlyQuestion(input: Readonly<{ text: string; kind: string }>): boolean {
  const text = normalizeGuardText(input.text);
  if (!text) return false;
  if (matches(COMPANY_HISTORY, text)) return true;
  if (matches(PERSONAL_HANDLE, text)) return true;
  return input.kind === 'textarea' && matches(OPEN_QUESTION, text);
}

/** 法律声明 / 同意条款勾选——代勾等于替用户做法律声明。 */
/**
 * 法律声明勾选——**分两档**（`PD-2026-08-18-IRONCLAD-5-SPLIT`，**已于 2026-08-19 三人签字合入**；
 * ⚠️ 但签字≠放行——乙档代勾仍不得上生产，三道闸见 10-产品方案 §4.4bis）。
 *
 * 「法律声明勾选」在真实申请表上不是一类东西，性质差别很大：
 *
 * | 档 | 例子 | 声明的内容 |
 * |---|---|---|
 * | **信息属实**（`ATTESTATION`） | `I certify that the information provided is accurate` | 「我填的是真的」——而那些内容确实是用户自己的档案 |
 * | **实质授权**（`CONSENT_GRANT`） | 背景调查同意、仲裁协议、信用/药检授权、营销订阅、联系现任雇主及混合授权 | 把一项**新的权利**让渡给雇主或第三方 |
 *
 * 已生效裁决：ATTESTATION 归乙档；获 production 放行后，只可依据 Profile 中用户明确保存的值
 * 确定性代勾，且每次写入前必须通过阻塞式确认。当前 classifier 仍把所有 CONSENT_GRANT
 * 统一挡住；其中背景调查、仲裁、信用／药检授权是 `PENDING_L2P_PROPOSAL` 的逐项候选，营销订阅、
 * 联系现任雇主与未列明／混合授权始终由用户本人完成。final convergence 前两组都不启用自动写入。
 */
export const LEGAL_ATTESTATION =
  /\bi (certify|confirm|declare|attest|acknowledge)\b|\bcertif(y|ication)\b|\backnowledg(e|ement)\b|\bto the best of my knowledge\b|\bi (have )?(read|reviewed?|received?|understand|understood|completed?)\b.{0,160}\b(handbook|policy|notice|document|terms|code of conduct|training|orientation)\b|本人(确认|声明|保证)|已(阅读|审阅|收到|知悉|理解|完成).{0,120}(手册|政策|通知|文件|条款|守则|培训)/i;

/**
 * 乙档的正向闭集：**整条声明**必须只表达「我在作证」、「对象是已填的
 * application/profile 信息」、「该信息真实／准确／完整」。
 *
 * `I confirm that I have read the handbook` 和 `I certify that I received a copy`
 * 只表示用户已阅读或已收到某份文件，可能有独立法律效果；即使含
 * confirm/certify，也不是本产品被批准代勾的「信息属实」。英文路径使用
 * 全句正向语法，不允许多出「已阅读」「已收到」「已参加」等第二个断言；
 * 这不是枚举 handbook/policy 两个黑名单词。
 */
const ENGLISH_INFORMATION_NOUN =
  String.raw`(?:information|details|facts|statements?|answers?|responses?)`;
const ENGLISH_APPLICATION_CONTEXT =
  String.raw`(?:in (?:this|the|my) application|in (?:the|my) profile)`;
const ENGLISH_BOUND_INFORMATION = String.raw`(?:` +
  String.raw`(?:application|profile) ${ENGLISH_INFORMATION_NOUN}(?: (?:i )?(?:provided|entered|submitted|supplied|included|gave|contained))?` +
  String.raw`|${ENGLISH_INFORMATION_NOUN} (?:` +
  String.raw`(?:i )?(?:provided|entered|submitted|supplied|included|gave)(?: ${ENGLISH_APPLICATION_CONTEXT})?` +
  String.raw`|contained ${ENGLISH_APPLICATION_CONTEXT}` +
  String.raw`|above` +
  String.raw`|${ENGLISH_APPLICATION_CONTEXT}` +
  String.raw`)` +
  String.raw`)`;
const ENGLISH_TRUTHFULNESS_ATTESTATION = new RegExp(
  String.raw`^i (?:certify|confirm|declare|attest)(?: that)? (?:all |the |my )?${ENGLISH_BOUND_INFORMATION} (?:is|are|was|were|to be) (?:true|accurate|complete|correct|truthful|not misleading)(?:\s*(?:,|and)\s*(?:true|accurate|complete|correct|truthful|not misleading))*(?: to the best of my knowledge)?[.!]?$`,
  'i',
);
const CHINESE_BOUND_INFORMATION =
  String.raw`(?:(?:以上|上述)(?:(?:所填|所填写|填写|所提供|提供|所提交|提交)(?:的)?)?|(?:所填|所填写|填写|所提供|提供|所提交|提交)(?:的)?|(?:本|此)?(?:申请|申请表|个人资料|档案)(?:中)?(?:(?:所填|所填写|填写|所提供|提供|所提交|提交)(?:的)?)?)(?:信息|资料|内容|答案|情况)`;
const CHINESE_TRUTHFULNESS_ATTESTATION = new RegExp(
  String.raw`^本人(?:确认|声明|保证)${CHINESE_BOUND_INFORMATION}(?:均|都|为|是|系)?(?:真实|属实|准确|完整|无误)(?:[、，,\s]*(?:真实|属实|准确|完整|无误))*[。.!]?$`,
  'i',
);

export function isTruthfulnessAttestation(value: string): boolean {
  const text = normalizeGuardText(value);
  return (
    ENGLISH_TRUTHFULNESS_ATTESTATION.test(text) ||
    CHINESE_TRUTHFULNESS_ATTESTATION.test(text)
  );
}

/**
 * 实质授权类勾选——当前 runtime **一律不代勾**，不受任何现有 opt-in 开关影响。
 * 该保守闭集同时包含 pending proposal 候选与永久人工类别；现行 wire 尚不能安全拆分，
 * 所以 final-head L2-P 批准和专用 durable release consumer 落地前不得从这里打开任何一项。
 *
 * ⚠️ 排在 ATTESTATION **之前**判：`I authorize a background check` 同时命中
 * 「i authorize」与背景调查，必须落在这一档。顺序本身是安全属性。
 */
/**
 * **授权动词**——不要求主语，出现即甲档。
 *
 * ## 为什么必须这样，而不是继续往 `CONSENT_GRANT` 加词
 *
 * 审查实测（2026-08-19，9/9 泄漏）：`CONSENT_GRANT` 原来用
 * `\bi (consent|authorize|waive)\b`——**要求人称代词紧邻动词**。
 * 而英语并列句会省略后半句的主语，这恰好是美国求职申请书认证段的**标准样板**：
 *
 * | 文案 | 原判定 |
 * |---|---|
 * | `I certify the above is true and **I** authorize investigation…` | NEVER（拦住） |
 * | `I certify the above is true and authorize investigation…` | **OPT_IN_ELIGIBLE（放行）** |
 *
 * 只差一个 "I"。同类泄漏还有 `and consent to…`、`and waive…`。
 *
 * 而且具名对象是闭集，永远追不完：`Terms of Service` / `Terms of Use`
 * （原来只认 `terms and conditions`）、`consumer report`（FCRA 的法定术语，
 * 原来只认 `credit report`）、`pre-employment screening`（原来要求 `background` 前缀）、
 * `my typed name below constitutes my signature`、中文「员工手册及规章制度」。
 *
 * **黑名单追不上开放集合。** 属实声明的句式反过来极其定型——
 * 它只说「我填的是真的」。所以判据改成**正向收窄**：
 * 整条 label 里只要出现任何授权动词，无论主语在不在，一律落甲档。
 *
 * 代价方向是对的（`attest.ts` 头注那条不对称）：误否一条真声明 = 用户多点一下；
 * 误纳一条授权 = 替用户签了他没读过的东西。
 */
export const AUTHORIZATION_VERB =
  /\bauthoriz|\bauthoris|\bconsent|\bwaiv(e|er|ing)\b|\bpermission\b|\brelease[sd]?\b|\bsubscrib|\bagree|\baccept|\bdisclos|\bindemnif|\b(electronic|digital|e-)[ -]?signature\b|constitutes my (legal )?signature|授权|同意|免除|放弃|委托|承诺遵守/i;

export const CONSENT_GRANT =
  new RegExp(
    [
      // ── 具名的授权对象
      String.raw`\bbackground (check|screening|investigation)\b`,
      String.raw`\barbitrat(e|ion)\b`,
      String.raw`\bcredit (check|report)\b`,
      String.raw`\bdrug (test|screen)\b`,
      String.raw`\bterms (and|&) conditions\b`,
      String.raw`\bprivacy policy\b`,
      String.raw`\bsubscribe\b`,
      String.raw`\bmarketing\b`,
      // ── 第一人称授权动词
      String.raw`\bi (consent|authorize|authorise|waive|permit)\b`,
      // ── 「给出许可」：Yiwen 审 PR #20（2026-08-18）实测缺口。
      //    `I give Acme permission to contact my current employer` 此前
      //    两层全放行（classifyManualOnly=null、evaluateClickTarget=allowed）。
      String.raw`\b(give|gives|giving|grant|grants|granting)\b[^.;]{0,48}\bpermission\b`,
      String.raw`\bpermission to (contact|obtain|access|verify|release|share|disclose)\b`,
      // ── 免责/放弃：`I hereby release my previous employer from liability`
      String.raw`\b(hereby )?releases?\b[^.;]{0,48}\b(from (any |all )?(liability|claims|responsibility)|liability)\b`,
      // ── 联系雇主/推荐人：这是把「向第三方核实」的权利交出去
      String.raw`\bcontact(ing)? (my |any |all |each )?(current|former|previous|prior|past)? ?(employer|employers|supervisor|manager|references?|referees?)\b`,
      // ── 电子签名：法律上等同签字，与勾选属实声明不是一回事
      String.raw`\b(electronic|digital|e-)[ -]?signature\b`,
      String.raw`\bsign(ing)? (this )?(document |form )?electronically\b`,
      // ── 中文
      '背景调查', '仲裁', '信用报告', '药物?检测', '订阅', '营销',
      '同意.*(条款|协议|政策)',
      '授权.*(联系|查询|核实|调取)',
      '电子签名', '免除.*(责任|义务)',
    ].join('|'),
    'i',
  );

/**
 * 一次性验证码 / 二次验证 / 人机验证。`security code`（2026-10-04）：Greenhouse 把邮件里的验证码叫「Security code」；那一格从来
 * 不由填写计划写（只由他本人在浮层里输，见 `write/emailCode.ts`），与点击策略的那张拒绝表对齐。
 */
export const OTP_OR_CAPTCHA =
  /\b(otp|one[- ]?time (code|password)|verification code|security code|2fa|two[- ]?factor|mfa|captcha|recaptcha|hcaptcha)\b|验证码|人机验证/i;

/**
 * 当前 production 的 fail-closed 入口：三道生产闸未解前，这四类都不进写入计划。
 * 它保护的是当前 runtime，不代表四类共享同一永久产品语义。
 *
 * 与 `mustNeverAutofill` 的区别：那个只做「蜜罐文案 + 密码」两层且零调用方，
 * 名字却读起来像终极拒绝门（体检把它单列为一条风险——将来有人按名字采用它，
 * 会静默丢掉属性身份层与这里的另外三类）。**新代码一律用本函数。**
 */
export type ManualOnlyTier =
  /**
   * 当前 runtime 的硬拒绝闭集。密码、背景调查、仲裁、信用／药检授权属于 default-off
   * pending proposal；验证码／2FA／CAPTCHA、营销订阅、联系现任雇主与未列明／混合授权
   * 始终人工。现行 `NEVER` 是历史代码名，不得把它解释成所有成员永久具有同一产品语义。
   */
  | 'NEVER'
  /**
   * EEO 自我认同 / 「信息属实」声明——产品已裁定乙档 default-on，
   * 但只能依 Profile 明确值确定性处理，且每次写入前必须通过阻塞式确认。
   * `OPT_IN_ELIGIBLE` 是历史类型名，不得用它推导当前开关默认值。
   *
   * ⚠️ **工作授权与签证身份不在这一档**（Yiwen 审 PR #20 指出，核实成立）。
   * 这只是当前 classifier 的代码形状；产品裁决已把它划进乙档，但
   * **代码从未实现过**——
   * `classifyManualOnly('Will you require sponsorship…')` 返回 `null`，
   * 仍走 `engine.ts` 既有的 `JOB_DEPENDENT` 守卫。
   * `PD-2026-08-18-IRONCLAD-5-SPLIT` 已取代
   * `PD-2026-08-18-PROFILE-QUESTION-MODEL` 的 A2 执行语义，但能力尚未落地，
   * 且 production 仍被三道闸阻塞；现行代码继续由既有 `JOB_DEPENDENT` 守卫 fail closed。
   */
  | 'OPT_IN_ELIGIBLE';

/**
 * 分档判定——**导出以便直接单测**。
 *
 * 为什么必须能单测：`CONSENT_GRANT` 要排在 `LEGAL_ATTESTATION` 之前，
 * 这是**安全属性**——`I authorize a background check` 同时命中两档，
 * 判错档 = 把实质授权放进了「乙档可代勾」的那一堆。
 *
 * 为什么走 engine 测不出来：两档今天都产出同一个 `MANUAL_ONLY` 原因码，
 * 所以调换顺序**不会让任何经 engine 的用例变红**（实测：22 条照样全绿）。
 * 那就是一条不可证伪的安全声称，正是 `docs/64` §1 点名的形态。
 * 导出分档函数，顺序才当场可测——探针实测咬住三条复合标签
 * （`I certify that I consent to a background check` 一类）。
 *
 * 这一层今天对写入行为**没有影响**（两档都不填）。它是给已裁定的
 * 乙档 default-on + 逐次阻塞确认落地那天准备的：那时历史名为
 * `OPT_IN_ELIGIBLE` 的分支变成可写、`NEVER` 不变——顺序错的后果那一刻才显形，
 * 但测试现在就得在。历史类型名不代表当前开关默认值。
 */
export function classifyManualOnly(value: string): ManualOnlyTier | null {
  const text = normalizeGuardText(value);
  if (!text) return null;
  // 顺序即安全：三类 NEVER 先判尽，否则 "i authorize …" 会被 ATTESTATION 抢走。
  if (isPasswordField(text)) return 'NEVER';
  if (matches(OTP_OR_CAPTCHA, text)) return 'NEVER';
  if (matches(CONSENT_GRANT, text)) return 'NEVER';

  // 正向收窄**只否决乙档那一支**，不做全局规则。
  //
  // 第一版把它写成全局 `if (AUTHORIZATION_VERB) return 'NEVER'`——
  // 结果 `Are you legally authorized to work in the United States?` 也被判 NEVER
  // （测试当场抓到）。那句话是**在问用户的状态**，不是授出一项授权；
  // 它该走既有的 `JOB_DEPENDENT`（停下来问用户），不是铁律 5。
  //
  // 挂在乙档分支上才精确：风险只存在于「这条看起来是属实声明、
  // 我们打算代勾它」的那一刻。见 AUTHORIZATION_VERB 头注。
  const vetoed = matches(AUTHORIZATION_VERB, text);
  if (matches(SELF_IDENTIFICATION, text)) return vetoed ? 'NEVER' : 'OPT_IN_ELIGIBLE';
  if (matches(LEGAL_ATTESTATION, text)) {
    return vetoed || !isTruthfulnessAttestation(text) ? 'NEVER' : 'OPT_IN_ELIGIBLE';
  }
  return null;
}

/**
 * 结构化的铁律 5 判定——**看元素本身，不只看文案**。
 *
 * Yiwen 审 PR #20（2026-08-18）指出：此前只把 `label || key` 传给
 * `isManualOnlyField`，密码字段之所以不被填，纯粹因为 `TEXTUAL_INPUT_TYPES`
 * 白名单碰巧没有 `'password'`——**被动的、不是主动的**。她的变异探针：
 * 把 `password` 加进那张表，640 条测试**照样全绿**，而一个
 * `<label>Email</label><input type="password">` 会直接进写入计划。
 *
 * 一张把密码框 label 写成 "Email" 的表不是臆想——多步登录页、
 * 以及把 label 复用给上一格的错误标注，都会产生这个形状。
 * 文案匹配对它无能为力，只有看 `element.type` 才拦得住。
 */
export function isManualOnlyControl(input: ManualOnlyControlInput): boolean {
  return isPasswordControl(input) || isManualOnlyField(input.text);
}

export interface ManualOnlyControlInput {
  readonly text: string;
  readonly inputType?: string | null;
  readonly autocomplete?: string | null;
}

/**
 * 铁律 5 的甲档，看元素也看文案：密码、验证码、授权同意。
 * 用户在审阅面板里给了答案也不写——乙档（EEO 自我认同等）则可以由用户确认后写入。
 */
export function isNeverWritableControl(input: ManualOnlyControlInput): boolean {
  return isPasswordControl(input) || classifyManualOnly(input.text) === 'NEVER';
}

function isPasswordControl(input: ManualOnlyControlInput): boolean {
  if (input.inputType?.trim().toLowerCase() === 'password') return true;
  // `autocomplete="current-password" | "new-password"` 是浏览器与密码管理器
  // 认的密码信号，宿主用 type=text + autocomplete 藏密码框并不罕见。
  const auto = input.autocomplete?.trim().toLowerCase();
  return Boolean(auto && /(^|\s)(current|new)-password(\s|$)/.test(auto));
}

/** 铁律 5 的唯一入口：两档今天都不进写入计划。 */
export function isManualOnlyField(value: string): boolean {
  return classifyManualOnly(value) !== null;
}

/**
 * Every honeypot signal we can evaluate. Any single hit denies the field —
 * a false positive costs one manually-typed value, a false negative costs the
 * whole application.
 */
export interface HoneypotSignals {
  /** Label / placeholder / aria-label prose. */
  readonly text?: string;
  /** `name` / `id` / `class` / `data-automation-id` / `data-ui` / `data-qa`. */
  readonly identities?: ReadonlyArray<string | null | undefined>;
  readonly geometry?: HoneypotGeometry;
  /** Pre-computed by the caller (tabindex=-1, unlabelled, off-screen …). */
  readonly isLikelyHoneyPot?: boolean;
}

export function isHoneypot(signals: HoneypotSignals): boolean {
  if (signals.isLikelyHoneyPot) return true;
  if (signals.text && isHoneyPotField(signals.text)) return true;
  if (signals.identities && isHoneypotIdentity(signals.identities)) return true;
  if (signals.geometry && isHoneypotGeometry(signals.geometry)) return true;
  return false;
}

/** Conditions that deny every autofill path, regardless of field type. */
export function mustNeverAutofill(value: string): boolean {
  return isHoneyPotField(value) || isPasswordField(value);
}

/**
 * Re-exported so the UA-1 runtime reads the same author-declaration predicate the
 * legacy interpreter does (dict/controls.ts), instead of restating it.
 */
export { isSiteDeclaredNonInput } from './controls.ts';

/**
 * The semantic compiler's own role/type priority, re-exported so the UA-1
 * runtime decides "is this hidden control a question at all?" with the same
 * rule the compiler uses to build questions -- never a second, opposite one.
 */
export {
  FORM_ROLES,
  formalKindOfShape,
  isPureActivatorShape,
  type ControlShape,
} from '../semantic/grouping.ts';
