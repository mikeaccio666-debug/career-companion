/**
 * 代填条款、声明与签名（2026-09-23；负责人 2026-09-22 夜的决定）：哪些框、哪些栏可以以用户的名义填。
 *
 * 只有用户在门户资料页保存按钮旁**单独**勾过同意（后端存文案版本与时间）、运行时包又放行了
 * `sign-on-behalf`，引擎才会用到这里的判据。三类：
 *
 *  · TERMS_CONSENT —— 同意本次申请的条款／隐私政策（含「已阅读并同意」「接受」，以及为评估
 *    这份申请而处理个人数据的同意）；
 *  · TRUTH_ATTESTATION —— 保证所填属实（后面可以跟「如有不实，可能导致……」那一句后果）；
 *  · SIGNATURE_NAME / SIGNATURE_DATE —— 签名栏里的姓名与日期。只认明说是签名的栏；裸的
 *    Name / Date 不认，那是别的题。
 *
 * 判据是**正向**的：必须说到政策、属实或签名；并且掺了下面任何一件就不算——营销、订阅、短信、
 * 电话、背景调查、信用、药检、仲裁、放弃权利、免责、授权、核实、联系雇主或推荐人、以后的职位与
 * 人才库、保留资料、第三方、at-will。那些是另外的授权，负责人明确留给用户本人。
 *
 * 否定的写法（「I do not consent」「I don't agree」「I disagree」）不是同意，一律不认。
 *
 * 点击策略对「认得回来的那一句」仍然生效的绝对拒绝（动作名起头的 submit／apply…、sign in、
 * 登录与支付、验证、密码，见 click/policy.ts）命中了的，这里也不认，免得计划里排进一条注定失败的条目。
 *
 * 第二刀（2026-09-23）：选择题。Greenhouse 上这类题几乎都是单选下拉（Yes／No、Consent、
 * I agree、Acknowledge/Confirm），不是勾选框——见 `signOnBehalfAnswer`。
 *
 * 第四刀（2026-09-24；负责人的规矩「Jobright 勾的我们也勾」，Greenhouse Twilio 实测它三个都勾了）：
 * 条款同意再认申请者／候选人自己的政策与指引（「Candidate AI Responsible Use Policy」）；属实声明再认
 * 「交的是本人的作品」；为这份申请处理数据再认「处理我在上面人口统计问卷里的回答」（从前交还本人）。
 * 要分享、披露、转出去的，照旧交还本人。
 *
 * 第三刀（2026-09-24；负责人 2026-09-23 夜的决定）：同意类，见本文件后半的 `consentOnBehalfKind`。
 * 上面这几类的判据一字不动，只是说到同意类任何一类话题（录音／转写、短信、以后的职位与人才库、营销
 * 资讯、背景调查、仲裁）的一律不算条款同意或属实声明——两者混在一句里的，两边都不认。
 *
 * 第五刀（2026-09-28；负责人当天的决定）：再放宽一轮，见本文件末尾的 `widenedConsentKind`。前三刀的
 * 判据一字不动（只收紧），它们认不出的才轮到第五刀，第五刀只答新类别。同意书同一天改成一句话、升到
 * 2026-09-28，只有当前版本算数（`SIGNING_CONSENT_KINDS`）。能不能联系现在的雇主改成资料里的一问，
 * 按他的回答答（`employerContactAnswer`）。
 */
export type SignOnBehalfCheckboxKind = 'TERMS_CONSENT' | 'TRUTH_ATTESTATION';
/** 第三刀的六类同意（2026-09-24）。 */
export type ThirdCutConsentKind =
  | 'AI_RECORDING_CONSENT'
  | 'SMS_CONSENT'
  | 'FUTURE_CONTACT_CONSENT'
  | 'MARKETING_CONSENT'
  | 'BACKGROUND_CHECK_CONSENT'
  | 'ARBITRATION_AGREEMENT';
/** 第五刀新放行的同意类别（2026-09-28）：只由 2026-09-28 那一版文案覆盖。 */
export type WidenedConsentKind =
  /** 招聘用途的资料处理与分享：雇主的招聘服务商、招聘系统（ATS）及其关联或集团公司。 */
  | 'RECRUITING_DATA_SHARING'
  /** 核实所填信息：学历、工作经历、身份，E-Verify 的告知与确认。 */
  | 'INFORMATION_VERIFICATION'
  /** 背景调查的其余几种（这一次录用）：信用、药检、驾驶记录、社交媒体审查、定期复查。 */
  | 'SCREENING_CONSENT'
  /** at-will（随意雇佣）的确认。 */
  | 'AT_WILL_ACKNOWLEDGEMENT'
  /** 仲裁协议里的集体诉讼与陪审团弃权（同一份仲裁协议里的才算）。 */
  | 'ARBITRATION_WAIVER'
  /** AI 分析或评估面试录音。 */
  | 'AI_INTERVIEW_ANALYSIS'
  /** 与申请相关的电话与 WhatsApp 通知。 */
  | 'CALL_NOTIFICATION_CONSENT'
  /** 集团公司日后联系。 */
  | 'GROUP_FUTURE_CONTACT'
  /** 只有标题的隐私声明（「Applicant Privacy Notice」+ 一个肯定回答，正文读不到）。 */
  | 'PRIVACY_NOTICE_TITLE'
  /** 只由放行类别组成的混合。 */
  | 'COMBINED_CONSENT';
/** 同意类：第三刀的六类与第五刀的新类别，都按整段判据、选择题按整道题判。 */
export type ConsentOnBehalfKind = ThirdCutConsentKind | WidenedConsentKind;
/**
 * 能不能联系他的雇主或推荐人（2026-09-28）：不看同意书，按资料里那一问的回答答，答的方向写在类别里。
 * `EMPLOYER_*` 问现在的雇主；`REFERENCE_*` 问以前的雇主或推荐人（题目只问他们时照同一个回答答）。
 */
export type EmployerContactKind =
  | 'EMPLOYER_CONTACT_YES'
  | 'EMPLOYER_CONTACT_NO'
  | 'REFERENCE_CONTACT_YES'
  | 'REFERENCE_CONTACT_NO';
/** 勾选框、单选、下拉与代理题上能代填的全部类别。 */
export type SignOnBehalfChoiceKind = SignOnBehalfCheckboxKind | ConsentOnBehalfKind | EmployerContactKind;
export type SignatureFieldKind = 'SIGNATURE_NAME' | 'SIGNATURE_DATE';
export type SignOnBehalfKind = SignOnBehalfChoiceKind | SignatureFieldKind;

const MAX_CHECKBOX_LABEL_LENGTH = 600;
const MAX_SIGNATURE_LABEL_LENGTH = 200;

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/\s+/gu, ' ')
    .replace(/[\s*:：]+$/u, '')
    .trim()
    .toLowerCase();
}

/** 另外的授权：掺了任何一件都交还本人。 */
const OTHER_AUTHORIZATION = /* @__PURE__ */ new RegExp(
  [
    String.raw`\bmarketing\b`,
    String.raw`\bnewsletters?\b`,
    String.raw`\bsubscri(?:be|bing|ption)\b`,
    String.raw`\bpromotion(?:al|s)?\b`,
    String.raw`\bspecial offers?\b`,
    String.raw`\bjob alerts?\b`,
    String.raw`\btext messag(?:e|es|ing)\b`,
    String.raw`\bsms\b`,
    String.raw`\bautodial`,
    String.raw`\bphone calls?\b`,
    String.raw`\bcall me\b`,
    String.raw`\bbackground (?:check|screening|investigation|report)s?\b`,
    String.raw`\bconsumer reports?\b`,
    String.raw`\bcredit (?:check|report|history)s?\b`,
    String.raw`\bdrug (?:test|screen)`,
    String.raw`\barbitrat`,
    String.raw`\bclass action\b`,
    String.raw`\bjury\b`,
    String.raw`\bwaiv(?:e|er|ing)\b`,
    String.raw`\breleas(?:e|es|ing)\b`,
    String.raw`\bhold harmless\b`,
    String.raw`\bindemnif`,
    String.raw`\bauthori[sz]`,
    String.raw`\bpermission to\b`,
    String.raw`\bverif(?:y|ied|ication)\b`,
    String.raw`\bcontact(?:ing|ed)?\b[^.]{0,40}\b(?:employers?|supervisors?|managers?|references?|referees?)\b`,
    String.raw`\bfuture (?:job )?(?:opportunit|opening|position|role|vacanc)`,
    String.raw`\bother (?:roles|positions|jobs|opportunit|vacanc)`,
    String.raw`\btalent (?:community|network|pool|pipeline)\b`,
    String.raw`\bretain(?:ed|ing)?\b`,
    String.raw`\bthird[- ]part(?:y|ies)\b`,
    String.raw`\bshar(?:e|ed|ing) (?:my |your )?(?:personal )?(?:data|information|details)\b`,
    String.raw`\bsell\b`,
    String.raw`\bbiometric`,
    String.raw`\be-?verify\b`,
    String.raw`\bat[- ]will\b`,
    String.raw`\bnon[- ]?compete\b`,
    String.raw`\bnon[- ]?disclosure\b`,
    String.raw`\bconfidentiality agreement\b`,
  ].join('|'),
  'iu',
);

/**
 * 仍交还本人的几类（负责人 2026-09-28 列明）与没有列明的背景调查：整段里出现一处就不认。**每一刀都看它**——
 * 前三刀各自的否决漏过几种说法（「hold Acme harmless」「sale of personal information」「NDA」、条款同意里夹着
 * 健康信息），第五刀起一并拦住：这几类在哪一版的同意里都不代填。
 */
const KEPT_REFUSALS: readonly RegExp[] = [
  // 出售资料
  /\bsell(?:s|ing)?\b|\bsold\b|\bsale of\b/u,
  // 为营销分享资料（分享、披露、转给别人做营销或广告；营销伙伴；「为他们自己的用途」）
  /\b(?:shar(?:e|es|ed|ing)|disclos\w*|transfer\w*|provid(?:e|es|ed|ing)|rent\w*)\b[^.?!]{0,100}\b(?:marketing|advertis\w*|promotional)\b|\b(?:marketing|advertising) (?:partners?|purposes|affiliates|companies|lists?)\b|\bfor (?:their|its) own (?:marketing |commercial )?purposes\b|\btargeted advertising\b/u,
  // 生物特征
  /\bbiometric|\bfingerprint|\bfac(?:e|ial) (?:recognition|geometry|scans?|analysis|data|templates?)\b|\bfacial\b|\bvoice ?prints?\b|\bretina|\biris (?:scans?|recognition)\b|\bhand geometry\b/u,
  // 一般免责、不追责、赔偿（仲裁协议里只认集体诉讼与陪审团弃权，这几样一律不认）
  /\breleas(?:e|es|ed|ing)\b[^.?!]{0,100}\b(?:liabilit\w*|claims?|damages?|responsibilit\w*|causes? of action|lawsuits?|suits?)\b|\b(?:general|full|complete) releases?\b|\bhold(?:s|ing)? (?:[\p{L}'.-]+ ){0,4}harmless\b|\bindemnif\w*|\bdischarg\w*[^.?!]{0,60}\bliabilit/u,
  // 竞业、不招揽、保密协议
  /\bnon[- ]?(?:compet\w*|solicit\w*|disclosure)\b|\bconfidentiality (?:agreements?|obligations?|undertakings?|terms)\b|\bndas?\b|\brestrictive covenants?\b|\binvention assignments?\b|\bproprietary information (?:and inventions )?agreements?\b/u,
  // 医疗、健康、残障信息
  /\bmedical\b|\bhealth\b|\bdisabilit|\bphysical (?:exam\w*|assessments?)\b|\bgenetic\b|\bpregnan|\bmental (?:health|conditions?)\b/u,
  // 调查式消费者报告：要走访邻居、朋友、同事，没有列明
  /\binvestigative\b/u,
];

function keptRefusal(text: string): boolean {
  return KEPT_REFUSALS.some((pattern) => pattern.test(text));
}

/**
 * 点击策略对「认得回来的那一句」仍然生效的绝对拒绝（与 click/policy.ts 的 SIGNED_* 同口径）。
 *
 * 第二刀（2026-09-23）：勾选框、单选项、下拉选项结构上都提交不了表单，所以认得回来的那一句只把
 * 提交类动作词当动作名来判（在开头，像按钮名），`sign in` / `log in` 按整词判——「By submitting this
 * application, I certify…」「By signing below…」不再被一刀切。登录支付、验证、密码照旧整段文字判。
 */
const CLICK_ABSOLUTE_DENY =
  /^[^\p{L}\p{N}]*(?:submit|apply|send|next|continue|finish)(?![\p{L}\p{N}_])|\bsign(?:ing)?\s*in\b|\blog(?:ging)?\s*in\b|\blogins?\b|authenticat|payment|\bpay\b|credit card|debit card|billing|card number|cvv|cvc|otp|one[-\s]?time|passcode|verification|verify|security code|password/iu;

/**
 * 否定：「I do not consent」「I don't agree」「I disagree」「I decline」。「true and not misleading」
 * 是属实声明的一种说法，不算否定。
 */
const NEGATION = /\bnot\b|n't\b|\bdont\b|\bcannot\b|\bnever\b|\bdisagree|\bdecline|\brefus|\breject|\bopt(?:ing)?[- ]?out\b|\bunwilling/iu;

function negated(text: string): boolean {
  return NEGATION.test(text.replace(/\bnot misleading\b/gu, ''));
}

/**
 * 政策名词。第四刀（2026-09-24，Greenhouse Twilio）：再认申请者／候选人自己的政策与指引
 * （「Candidate AI Responsible Use Policy」「Applicant AI Use Guidelines」）——那也是这份申请的条款；
 * 名字里说到背景调查、药检一类的，照旧被上面的 OTHER_AUTHORIZATION 拦下。
 */
const POLICY_NOUN =
  /\bterms (?:and|&) conditions\b|\bterms of (?:service|use)\b|\bprivacy (?:policy|notice|statement)\b|\bdata (?:protection|privacy) (?:policy|notice|statement)\b|\bpersonal (?:data|information) (?:collection )?(?:notice|statement|policy)\b|\b(?:candidate|applicant|recruit(?:ment|ing)|hiring)(?: [\p{L}&'-]+){0,4} (?:policy|policies|guidelines|notice|statement)\b/iu;
const ASSENT_VERB =
  /\b(?:agree|agrees|agreed|accept|accepts|accepted|consent|consents|acknowledge|acknowledges|have read|read and understood|understand|understood)\b/iu;
/**
 * 为评估这份申请而处理个人数据：隐私同意的另一种写法（GDPR 表常见）。第四刀（2026-09-24）：处理的是
 * 这份申请里那几道人口统计／自愿自我认同问卷的回答，也算（Twilio：「I consent to Twilio collecting,
 * storing, and processing my responses to the demographic data surveys above.」）。
 */
const PROCESSING_FOR_THIS_APPLICATION =
  /\bconsent to\b[^.]{0,80}\b(?:processing|storage|storing|collection|use)\b[^.]{0,40}\b(?:my|your) (?:personal )?(?:data|information)\b[^.]{0,80}\b(?:my|your|this) (?:application|candidacy)\b|\bconsent to\b[^.]{0,80}\b(?:processing|storing|collecting)\b[^.]{0,40}\b(?:my|your) (?:responses?|answers?) (?:to|in) (?:the |these |this )?(?:demographic|diversity|voluntary|self[- ]identification|eeo)\b[^.]{0,20}\b(?:surveys?|questions?|questionnaires?)\b/iu;
/** 处理之外还要分享、披露、转出去的，是另一项授权。 */
const PROCESSING_BEYOND_THIS_APPLICATION = /\bshar(?:e|es|ed|ing)\b|\bdisclos|\btransfer|\bpartners?\b|\baffiliat/iu;

const TRUTH_SUBJECT = String.raw`(?:information|answers?|statements?|responses?|details|particulars|facts|everything|all of the above|the above)`;
/** 第四刀（2026-09-24）：「交的是本人的作品」（reflect my own work / are my own work）也是属实的一种说法。 */
const TRUTH_PREDICATE = String.raw`(?:true|accurate|correct|complete|truthful|not misleading|(?:reflects?|represents?|is|are) (?:entirely |solely )?(?:my|our) own (?:work|experience|words))`;
/**
 * 声明前常有的一句引子：「By submitting this application,」「By signing below,」；选择题的题面还会
 * 写成「Please confirm …」「Do you certify …?」（第二刀，2026-09-23）。
 */
const LEAD_IN = String.raw`(?:by (?:submitting|signing|checking|ticking|selecting|clicking)\b[^,.]{0,80},\s*)?`;
const ASKING = String.raw`(?:please |(?:do|can|will|would) you )?`;
const ATTESTATION = /* @__PURE__ */ new RegExp(
  String.raw`^${LEAD_IN}${ASKING}(?:i |we )?(?:hereby )?(?:certify|confirm|declare|attest|affirm|acknowledge)\b[^.?]{0,160}\b${TRUTH_SUBJECT}\b[^.?]{0,160}\b${TRUTH_PREDICATE}\b` +
    String.raw`|^${LEAD_IN}(?:the |all )?(?:information|answers|statements|details|facts)\b[^.]{0,120}\b(?:is|are)\b[^.]{0,20}\b${TRUTH_PREDICATE}\b`,
  'iu',
);
/** 属实声明后面常跟的那一句后果（「如有不实，可能导致……」）：它不是另一项授权。 */
const CONSEQUENCE_SENTENCE =
  /^(?:i )?(?:understand|acknowledge)\b[^.]*\b(?:false|misleading|incorrect|inaccurate|untrue|omissions?|misrepresentations?)\b[^.]*\.?$/iu;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 一个勾选框的标签属于哪一类可代填的同意／声明；都不是就 null（交还本人）。 */
export function signOnBehalfCheckboxKind(label: string): SignOnBehalfCheckboxKind | null {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_CHECKBOX_LABEL_LENGTH) return null;
  if (OTHER_AUTHORIZATION.test(text) || CLICK_ABSOLUTE_DENY.test(text) || mentionsConsentTopic(text) || keptRefusal(text)) return null;
  if (
    !negated(text) &&
    ((POLICY_NOUN.test(text) && ASSENT_VERB.test(text)) ||
      (PROCESSING_FOR_THIS_APPLICATION.test(text) && !PROCESSING_BEYOND_THIS_APPLICATION.test(text)))
  ) {
    return 'TERMS_CONSENT';
  }
  // 属实声明：第一句是声明，其余每一句都只能是「如有不实会怎样」（那一句里的 not 不算否定）。
  const [first, ...rest] = sentences(text);
  if (
    first !== undefined &&
    !negated(first) &&
    ATTESTATION.test(first) &&
    rest.every((sentence) => CONSEQUENCE_SENTENCE.test(sentence))
  ) {
    return 'TRUTH_ATTESTATION';
  }
  return null;
}

/**
 * 选择题里的肯定回答：Yes、I agree、Consent、Acknowledge/Confirm……（整项逐字，不做前缀）。
 * 它自己什么都不证明——只有题面已经判成可代填的一类时才算数。
 */
const AFFIRMATIVE_ANSWER =
  /^(?:yes|(?:yes,? )?i (?:agree|accept|acknowledge|consent|certify|confirm)|agree|agreed|accept|accepted|consent|acknowledge|acknowledged|confirm|confirmed|certify|acknowledge ?\/ ?confirm)[.!]?$/iu;
const NEGATIVE_ANSWER = /^(?:no\b|(?:i )?(?:do not|don't|dont) |i disagree\b|disagree\b|i decline\b|decline\b)/iu;

export function isAffirmativeAnswer(option: string): boolean {
  return AFFIRMATIVE_ANSWER.test(normalize(option));
}

/**
 * 下拉的选项要点开才看得见，计划期给这一串闭集候选，写入期逐个去撞真实菜单（恰好一项才落笔）；
 * 撞中的那一项在点击当下还要再过一次 `isAffirmativeAnswer`／整句判据（click/policy.ts）。
 */
export const SIGN_ON_BEHALF_COMBOBOX_ANSWERS: readonly string[] = /* @__PURE__ */ Object.freeze([
  'Yes',
  'I agree',
  'I accept',
  'I acknowledge',
  'I consent',
  'I confirm',
  'I certify',
  'Agree',
  'Accept',
  'Acknowledge',
  'Consent',
  'Confirm',
  'Certify',
]);

/**
 * 一道「选一项」的题，代填该选哪一项（第二刀，2026-09-23）。
 *
 *  · 题面判得出同意／声明：恰好一项是肯定回答，或者选项本身判成同一类；
 *  · 题面判不出（「Please review the linked document:」）：选项本身判得出的恰好一项，其余只能是
 *    否定回答（No／I do not agree…）。题面掺了别的授权、或者是否定句，照旧不选。
 *
 * 零项或多项都不选，交还本人。
 */
export function signOnBehalfAnswer(
  question: string,
  options: readonly string[],
): Readonly<{ kind: SignOnBehalfCheckboxKind; index: number }> | null {
  const kind = signOnBehalfCheckboxKind(question);
  if (kind !== null) {
    const hits = options.flatMap((option, index) =>
      isAffirmativeAnswer(option) || signOnBehalfCheckboxKind(option) === kind ? [index] : []);
    return hits.length === 1 ? { kind, index: hits[0]! } : null;
  }
  const text = normalize(question);
  if (
    text.length > MAX_CHECKBOX_LABEL_LENGTH || OTHER_AUTHORIZATION.test(text) || CLICK_ABSOLUTE_DENY.test(text) || negated(text) ||
    keptRefusal(text)
  ) {
    return null;
  }
  const kinds = options.map((option) => signOnBehalfCheckboxKind(option));
  const hits = kinds.flatMap((optionKind, index) => (optionKind === null ? [] : [index]));
  if (hits.length !== 1) return null;
  const index = hits[0]!;
  const othersDecline = options.every((option, other) => other === index || NEGATIVE_ANSWER.test(normalize(option)));
  return othersDecline ? { kind: kinds[index]!, index } : null;
}

const SIGNATURE_DATE =
  /^(?:signature date|date signed|signed date|date of signature|(?:today's|todays|current) date|date \(today\)|date today)$/iu;
const SIGNATURE_NAME: readonly RegExp[] = [
  /^(?:(?:applicant|candidate)(?:'s)? |your |electronic |digital |e-?|typed )*signature$/iu,
  /^(?:please )?(?:type|enter) (?:in )?your (?:full |legal |full legal )?name\b.*\b(?:signature|sign)\b/iu,
  /^(?:full |legal |full legal )?name \(?(?:as )?(?:your )?(?:electronic |digital )?signature\)?$/iu,
  /^sign(?:ed)?(?: here)?$/iu,
];

/** 一个文本栏是不是签名栏的姓名或日期；裸的 Name / Date 不算（null）。 */
export function signatureFieldKind(label: string): SignatureFieldKind | null {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_SIGNATURE_LABEL_LENGTH) return null;
  if (OTHER_AUTHORIZATION.test(text) || keptRefusal(text)) return null;
  if (SIGNATURE_DATE.test(text)) return 'SIGNATURE_DATE';
  if (SIGNATURE_NAME.some((pattern) => pattern.test(text))) return 'SIGNATURE_NAME';
  return null;
}

// ── 第三刀（2026-09-24）：同意类 ──────────────────────────────────────────────────────────────
//
// 负责人 2026-09-23 夜的决定：「竞品能自动勾的我们也勾，资料页勾过就代表同意，只要我们说明」。
// 六类：AI 面试记录／转写、与申请相关的短信、日后联系与人才库、营销信息、背景调查授权、仲裁协议的
// 阅读确认与同意。信任根与前两刀相同（资料页单独勾过、文案逐类点名的当前版本 ∧ `sign-on-behalf`）。
//
// 判据是**整段**的。先切句，每一句只能是四种之一，有一句说不上来整段就不认：
//  · 同意句：说到这一类，并且是同意的说法——第一人称（I agree / I consent / I would like / I authorize /
//    I have read and agree / I will read）、「By …, you agree」、征求同意的问句（Do you consent…? /
//    Would you like…? / May we contact you…?）、或「Join our talent community」一类的祈使句；
//  · 说明句：说到这一类，只是陈述（「We conduct background checks as part of our hiring process.」）；
//  · 指代句：只有同意、没有内容（「Do you consent?」「By selecting "Yes," you acknowledge and consent.」）；
//  · 套话：短信资费与退订、「同意不是录用条件」、「不同意也不影响你的申请」、「如果不愿意，选 No」。
// 整段恰好说到一类：两类以上是混合授权；掺了条款同意（没写成「按隐私政策」那种引用）或属实声明，
// 也是混合。否决在整段上判（`CONSENT_VETO_ALL` 与各类自己的 `CONSENT_VETO`）；否定句不是同意，
// 套话里的 not 不算。

const CONSENT_KINDS: readonly ThirdCutConsentKind[] = /* @__PURE__ */ Object.freeze([
  'AI_RECORDING_CONSENT',
  'SMS_CONSENT',
  'FUTURE_CONTACT_CONSENT',
  'MARKETING_CONSENT',
  'BACKGROUND_CHECK_CONSENT',
  'ARBITRATION_AGREEMENT',
]);

/** 同意类：第三刀的六类，或第五刀的新类别。 */
export function isConsentKind(kind: string | undefined): kind is ConsentOnBehalfKind {
  return CONSENT_KINDS.includes(kind as ThirdCutConsentKind) || WIDENED_KINDS.includes(kind as WidenedConsentKind);
}

/** 能不能联系雇主或推荐人（2026-09-28，按资料里的回答答）。 */
export function isEmployerContactKind(kind: string | undefined): kind is EmployerContactKind {
  return EMPLOYER_CONTACT_KINDS.includes(kind as EmployerContactKind);
}

/**
 * 按整道题判的类别：同意类与「能不能联系雇主」。它们在 ARIA 代理题、listbox 下拉上也代填——点击当下题干与
 * 选项各认一遍，下拉在菜单打开后按整道题重判（条款同意与属实声明不走这两条路）。
 */
export function isWholeQuestionKind(kind: string | undefined): kind is ConsentOnBehalfKind | EmployerContactKind {
  return isConsentKind(kind) || isEmployerContactKind(kind);
}

/** 勾选框、单选、下拉与代理题上能代填的类别（签名栏那两类不算）。 */
export function isSignOnBehalfChoiceKind(kind: string | undefined): kind is SignOnBehalfChoiceKind {
  return kind === 'TERMS_CONSENT' || kind === 'TRUTH_ATTESTATION' || isWholeQuestionKind(kind);
}

/** 每一类的话题词（营销只认「营销／推广的邮件、资讯」，不认营销这个行业）。 */
const CONSENT_TOPIC: Readonly<Record<ThirdCutConsentKind, RegExp>> = /* @__PURE__ */ Object.freeze({
  AI_RECORDING_CONSENT:
    /\brecord(?:ed|ing|ings)\b|\brecord (?:my|your|our|the|this|these|all|each)\b|\btranscri(?:be|bed|bes|bing|pt|pts|ption|ptions)\b|\bnote[- ]?tak(?:er|ers|ing)\b/u,
  SMS_CONSENT: /\bsms\b|\btext messag(?:e|es|ing)\b|\btext(?:s|ing)? (?:me|you|updates?|alerts?|notifications?|reminders?)\b/u,
  FUTURE_CONTACT_CONSENT:
    /\b(?:future|other) (?:(?:job|career|employment) )?(?:opportunit|opening|position|role|vacanc)|\btalent (?:community|network|pool|pipeline|database)\b|\bjob alerts?\b/u,
  MARKETING_CONSENT:
    /\b(?:marketing|promotional) (?:e-?mails?|communications?|messages?|materials?|information|updates|content|offers)\b|\bnewsletters?\b|\bspecial offers?\b|\bproduct (?:news|updates|announcements)\b/u,
  BACKGROUND_CHECK_CONSENT: /\bbackground (?:check|screening|investigation|report)s?\b|\bpre-?employment screening\b/u,
  ARBITRATION_AGREEMENT: /\barbitrat/u,
});

/** 录音／转写只认面试、通话一类的场合：「recording studio」不是面试录音。 */
const INTERVIEW_CONTEXT = /\b(?:interviews?|conversations?|calls?|meetings?|screenings?|sessions?|discussions?)\b/u;

/**
 * 六类都不许掺的：联系现任雇主、点名他人（推荐人、以前的雇主、学校）、第三方与合作方、分享与出售、
 * 信用、药检、消费者报告、生物特征、核实、免责与放弃权利、at-will、竞业与保密协议、E-Verify、
 * 健康与残障、社交媒体。
 *
 * 写成一串正则字面量（不拼字符串）：这一段模块顶层没有任何调用，只用得到扫描那一半的 worker 包就能把
 * 整段判据摇掉（2026-09-24，见 click/policy.ts 的 `SigningGrammar`）。
 */
// 前四条是「点名他人」（现任雇主、以前的雇主、推荐人、联系雇主或学校）：第五刀的「能不能联系雇主」
// （`employerContactForm`）问的正是这几样，所以只拿第五条往后的去否决——调整顺序时两处一起看。
const CONSENT_VETO_ALL: readonly RegExp[] = [
  /\b(?:current(?:ly)?|present) (?:employer|company|supervisor|manager)s?\b/u,
  /\b(?:former|previous|past|prior) (?:employers?|supervisors?|managers?)\b/u,
  /\b(?:my|your|the|listed|provided|professional|personal) references\b|\breference (?:check|checks|checking)\b|\breferees?\b/u,
  /\bcontact(?:s|ing|ed)?\b[^.?!]{0,60}\b(?:employers?|supervisors?|managers?|colleagues?|co-?workers?|schools?|universit)/u,
  /\bthird[- ]part|\baffiliat|\bpartners?\b|\bvendors?\b|\bservice providers?\b|\bclients?\b|\bpowered by\b/u,
  /\bsell\b|\bsold\b|\bshar(?:e|es|ed|ing)\b/u,
  /\bcredit\b|\bdrug\b|\bconsumer reports?\b|\binvestigative\b/u,
  /\bbiometric|\bfingerprint|\bfacial\b|\bvoice ?prints?\b/u,
  /\bverif/u,
  /\bwaiv|\brelease\b|\bhold harmless\b|\bindemnif|\bclass action|\bjury\b/u,
  /\bat[- ]will\b|\bnon[- ]?(?:compete|solicit|disclosure)|\bconfidentiality agreement\b|\be-?verify\b/u,
  /\bmedical\b|\bhealth\b|\bdisabilit|\bsocial media\b/u,
];

/** 各类自己的否决。 */
const CONSENT_VETO: Readonly<Record<ThirdCutConsentKind, RegExp | null>> = /* @__PURE__ */ Object.freeze({
  // 录下来之后再拿 AI 去评估、打分、做决定、训练模型，是另一件事。
  AI_RECORDING_CONSENT: /\b(?:analy[sz]|assess|evaluat|scor(?:e|es|ed|ing)\b|rank(?:s|ed|ing)?\b|decisions?\b|emotion|train(?:s|ed|ing)?\b)/u,
  // 与申请相关的短信：电话、自动拨号、营销推广、WhatsApp 都不是。
  SMS_CONSENT: /\bcalls?\b|\bvoice\b|\bautodial|\bautomatic (?:telephone )?dialing|\bmarketing\b|\bpromotion|\boffers?\b|\bdeals?\b|\bwhatsapp\b/u,
  // 日后联系是这一家：转给集团里别的公司不算。
  // 第五刀（2026-09-28）补上「group of companies」「sister／parent company」：集团公司日后联系是新类别，旧版本的同意不覆盖。
  FUTURE_CONTACT_CONSENT: /\bsubsidiar|\bgroup (?:of )?(?:companies|entities)\b|\bother companies\b|\b(?:sister|parent) compan/u,
  MARKETING_CONSENT: /\bcalls?\b/u,
  // 这一次录用的背景调查：在职期间反复查、驾驶记录、核实学历与工作经历（要联系学校与以前的雇主）不算。
  BACKGROUND_CHECK_CONSENT:
    /\bongoing\b|\bcontinuous(?:ly)?\b|\bperiodic|\b(?:during|throughout) (?:my|your|the) employment\b|\bmotor vehicle\b|\bdriving\b|\beducation|\b(?:employment|work) history\b/u,
  ARBITRATION_AGREEMENT: null,
});

/** 仲裁协议自带的放弃陪审团审理／集体诉讼：它就是这份协议的内容，不算另一项授权。 */
const ARBITRATION_WAIVER =
  /\bwaiv(?:e|er|ing)(?: of)? (?:my|your|the|any)(?: rights?)?(?: to)?(?: a)? (?:jury(?: trial)?|trial by jury|class(?: or collective)? actions?)\b|\b(?:jury(?: trial)?|class action) waivers?\b/gu;

/**
 * 同意的说法（只在说到这一类的那一句里找）。公司自称的「we」不算：那是在陈述，不是他同意。
 * 问他的（Do you…? / Would you like…?）要有同意一类的动词；「May we contact / text / record you?」是
 * 在征求他的许可，动词可以是那件事本身。「Do you know that we record interviews?」两样都不是。
 */
const CONSENT_ASSENT: readonly RegExp[] = [
  /\bi(?:'d| would| will| am| have| do| hereby| also| fully| expressly)*(?: read(?: and)?)? (?:agree|consent|accept|acknowledge|authori[sz]e|understand|opt[- ]?in|like|wish|want|willing|allow|give|read)\b/u,
  /\byou (?:hereby |also |expressly )?(?:agree|consent|acknowledge|authori[sz]e|accept|understand|opt[- ]?in)\b/u,
  /^(?:do|would|will|can|could|may|are) you\b[^?]*\b(?:consent|agree|accept|acknowledge|authori[sz]e|understand|like|want|wish|willing|opt|allow|join|subscribe)\b/u,
  /^(?:(?:may|can|could) we|is it (?:ok|okay|alright|all right) (?:if|for) (?:we|us))\b[^?]*\b(?:contact|text|record|reach out|keep|add|include|email|message)\b/u,
  /^(?:yes[,!]? )?(?:please )?(?:join|sign me up|subscribe me|opt me in|opt[- ]?in to|add me|keep me|include me|contact me|text me|notify me|keep my)\b/u,
];

/** 指代句：整句只有同意、没有内容（「Please select one」不是同意）。 */
const CONSENT_POINTER =
  /^(?:(?:by (?:selecting|checking|clicking|choosing|ticking|answering)\b[^,]{0,40},["”'’]?\s*)?(?:you|i)(?: hereby)? (?:acknowledge|agree|consent|confirm|authori[sz]e|accept)(?:,? and (?:acknowledge|agree|consent|confirm|authori[sz]e|accept))*(?: to (?:this|the above|it|that))?|(?:do|will|would) you (?:consent|agree|accept|acknowledge|authori[sz]e)(?: to (?:this|the above|it|that))?|please (?:confirm|acknowledge|indicate your (?:consent|agreement))(?: your (?:consent|agreement))?)[.?!]?$/u;

/** 套话（整句从头认）：短信资费与退订、「同意不是录用条件」、「不同意也不影响」、「如果不愿意……」、「详见隐私政策」。 */
const CONSENT_BOILERPLATE: readonly RegExp[] = /* @__PURE__ */ Object.freeze([
  /^(?:standard )?(?:msg|message)s?(?: (?:and|&))? data rates (?:may|will) apply\b/u,
  /^(?:msg|message) (?:frequency|freq\.?) (?:may )?var(?:y|ies)\b/u,
  /^(?:you (?:can|may) )?(?:reply|text) ["'“]?(?:stop|help)\b/u,
  /^(?:your )?(?:consent|agreeing|opting in|this)(?: to [^.?!]{0,40})? is not (?:a |required as a )?(?:condition|requirement)\b/u,
  /^(?:you (?:can|may) )?(?:opt[- ]?out|unsubscribe|withdraw (?:your |this )?consent|change your (?:mind|preferences?))\b/u,
  /^(?:declining|not consenting|opting out|your (?:choice|decision|answer|response))\b[^.?!]{0,80}\b(?:will not|won't|does not|doesn't)\b[^.?!]{0,20}\b(?:affect|impact|influence)\b/u,
  /^if you (?:do not|don't|prefer not|would (?:rather|prefer) not|choose not|decline|wish not|opt out)\b/u,
  /^(?:please )?(?:see|view) (?:our|the)\b[^.?!]{0,40}\b(?:privacy (?:policy|notice|statement)|terms)\b/u,
]);
const MAX_BOILERPLATE_LENGTH = 160;
const MAX_TITLE_LENGTH = 160;

/** 「按隐私政策」那种引用：政策是依据，不是另一项同意。 */
const POLICY_REFERENCE =
  /\b(?:in accordance with|as described in|described in|pursuant to|subject to|per|under|consistent with|governed by|outlined in|explained in|set (?:forth|out) in|detailed in|according to) (?:[\p{L}\p{N}&.'-]+ ){0,3}?(?:privacy (?:policy|notice|statement)|terms (?:and|&) conditions|terms of (?:service|use)|data (?:protection|privacy) (?:policy|notice|statement)|(?:candidate|applicant|recruit(?:ment|ing)|hiring)(?: [\p{L}&'-]+){0,4} (?:policy|policies|guidelines|notice|statement))\b/gu;
const TRUTH_MIX =
  /\b(?:certif(?:y|ies|ied|ication)|attest|affirm|declare)\b|\b(?:information|answers?|statements?|details)\b[^.?!]{0,80}\b(?:is|are)\b[^.?!]{0,20}\b(?:true|accurate|correct|truthful)\b/u;

/**
 * 同意类的否定回答（标题题面下，其余选项只能是这些）；原生下拉的空白占位项（「」「Select...」）
 * 不是一个回答，也放过。
 */
const CONSENT_NEGATIVE =
  /^(?:no\b|(?:i )?(?:do not|don't|dont|will not|won't|would not|wouldn't|prefer not)\b|i disagree\b|disagree\b|i decline\b|decline\b|opt[- ]?out\b|not now\b)|^(?:-*|(?:please )?(?:select|choose)(?: one| an option)?(?:\.\.\.|…)?)$/u;

/** 同意类多认的几种肯定回答（旧的四类不用）。 */
const CONSENT_AFFIRMATIVE =
  /^(?:(?:yes,? )?i (?:authori[sz]e|understand(?: and (?:agree|accept|consent))?|opt[- ]?in|am willing)|opt[- ]?in|yes,? (?:please|opt me in|i would like to|i'd like to))[.!]?$/u;

/** 这一类的肯定回答：旧的闭集，同意类另加授权、知悉、opt in 几种说法。 */
export function isAffirmativeAnswerFor(kind: SignOnBehalfChoiceKind, option: string): boolean {
  return isAffirmativeAnswer(option) || (isConsentKind(kind) && CONSENT_AFFIRMATIVE.test(normalize(option)));
}

/** 说到了同意类的任何一类话题（不问场合）：条款同意、属实声明里掺了它，就是混合。 */
function mentionsConsentTopic(text: string): boolean {
  return CONSENT_KINDS.some((kind) => CONSENT_TOPIC[kind].test(text));
}

/** 整段恰好说到哪一类（AI 录音另要面试、通话一类的场合）；零类或多类都是 null。 */
function soleTopic(text: string): ThirdCutConsentKind | null {
  const kinds = CONSENT_KINDS.filter((kind) => CONSENT_TOPIC[kind].test(text));
  if (kinds.length !== 1) return null;
  const kind = kinds[0]!;
  return kind === 'AI_RECORDING_CONSENT' && !INTERVIEW_CONTEXT.test(text) ? null : kind;
}

function consentVetoed(text: string, kind: ThirdCutConsentKind): boolean {
  const scoped = kind === 'ARBITRATION_AGREEMENT' ? text.replace(ARBITRATION_WAIVER, ' ') : text;
  return CONSENT_VETO_ALL.some((pattern) => pattern.test(scoped)) || CONSENT_VETO[kind]?.test(scoped) === true;
}

/** 掺了条款同意（不是引用）或属实声明。 */
function mixesTermsOrTruth(text: string): boolean {
  return POLICY_NOUN.test(text.replace(POLICY_REFERENCE, ' ')) || TRUTH_MIX.test(text);
}

type ConsentSentence = 'ASSENT' | 'CONTEXT' | 'POINTER' | 'BOILERPLATE';

function consentSentence(sentence: string, kind: ThirdCutConsentKind): ConsentSentence | null {
  if (sentence.length <= MAX_BOILERPLATE_LENGTH && CONSENT_BOILERPLATE.some((pattern) => pattern.test(sentence))) return 'BOILERPLATE';
  if (negated(sentence)) return null;
  if (!CONSENT_TOPIC[kind].test(sentence)) return CONSENT_POINTER.test(sentence) ? 'POINTER' : null;
  return CONSENT_ASSENT.some((pattern) => pattern.test(sentence)) ? 'ASSENT' : 'CONTEXT';
}

/** 一句话（勾选框的标签、选择题的题面或选项）是不是六类同意之一的整句同意；都不是就 null。 */
export function consentOnBehalfKind(label: string): ThirdCutConsentKind | null {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_CHECKBOX_LABEL_LENGTH || CLICK_ABSOLUTE_DENY.test(text) || keptRefusal(text)) return null;
  const kind = soleTopic(text);
  if (kind === null || consentVetoed(text, kind)) return null;
  const parts = sentences(text);
  const roles = parts.map((sentence) => consentSentence(sentence, kind));
  if (roles.includes(null)) return null;
  if (mixesTermsOrTruth(parts.filter((_, index) => roles[index] !== 'BOILERPLATE').join(' '))) return null;
  return roles.includes('ASSENT') || (roles.includes('POINTER') && roles.includes('CONTEXT')) ? kind : null;
}

/**
 * 同一类、没有同意动词的一句题面（「Agreement to Arbitrate」「Please read the arbitration agreement
 * below」「SMS opt-in」）。它自己不是同意：只在选项本身是这一类的整句同意时，才让那一项算数。
 */
export function consentTopicTitle(label: string): ThirdCutConsentKind | null {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_TITLE_LENGTH || CLICK_ABSOLUTE_DENY.test(text)) return null;
  if (sentences(text).length !== 1 || negated(text) || keptRefusal(text)) return null;
  const kind = soleTopic(text);
  return kind === null || consentVetoed(text, kind) || mixesTermsOrTruth(text) ? null : kind;
}

/**
 * 勾选框、选择题的题面或选项：前两刀的条款同意／属实声明，第三刀的六类同意；前面都认不出的，再看第五刀的
 * 新类别与只有标题的隐私声明。「能不能联系雇主」不在这里——它看资料里的回答（`employerContactCheckboxKind`）。
 */
export function signOnBehalfChoiceKind(label: string): SignOnBehalfChoiceKind | null {
  return signOnBehalfCheckboxKind(label) ?? consentOnBehalfKind(label) ?? widenedConsentKind(label) ??
    (privacyNoticeTitle(label) ? 'PRIVACY_NOTICE_TITLE' : null);
}

/**
 * 同意类的选择题该选哪一项：
 *  · 题面本身是这一类的整句同意：恰好一项是肯定回答（或本身是这一类的整句同意）；
 *  · 题面是这一类的标题、或不沾任何一类的一句话：恰好一项本身是（这一类的）整句同意，其余只能是否定回答。
 * 零项或多项都不选。
 */
function consentOnBehalfAnswer(
  question: string,
  options: readonly string[],
): Readonly<{ kind: ThirdCutConsentKind; index: number }> | null {
  const asked = consentOnBehalfKind(question);
  if (asked !== null) {
    const hits = options.flatMap((option, index) =>
      isAffirmativeAnswerFor(asked, option) || consentOnBehalfKind(option) === asked ? [index] : []);
    return hits.length === 1 ? { kind: asked, index: hits[0]! } : null;
  }
  const title = consentTopicTitle(question);
  const text = normalize(question);
  if (
    title === null &&
    (text.length > MAX_CHECKBOX_LABEL_LENGTH || OTHER_AUTHORIZATION.test(text) || POLICY_NOUN.test(text) ||
      CLICK_ABSOLUTE_DENY.test(text) || negated(text) || keptRefusal(text))
  ) {
    return null;
  }
  const kinds = options.map((option) => consentOnBehalfKind(option));
  const hits = kinds.flatMap((kind, index) => (kind !== null && (title === null || kind === title) ? [index] : []));
  if (hits.length !== 1) return null;
  const index = hits[0]!;
  const othersDecline = options.every((option, other) => other === index || CONSENT_NEGATIVE.test(normalize(option)));
  return othersDecline ? { kind: kinds[index]!, index } : null;
}

/**
 * 一道「选一项」的题，代填该选哪一项：前两刀的判据先答，答不了再看第三刀的同意类，再答不了才看第五刀。
 * 「能不能联系雇主」不在这里（`employerContactAnswer`，要资料里的回答）。
 */
export function signOnBehalfChoiceAnswer(
  question: string,
  options: readonly string[],
): Readonly<{ kind: SignOnBehalfChoiceKind; index: number }> | null {
  return signOnBehalfAnswer(question, options) ?? consentOnBehalfAnswer(question, options) ?? widenedAnswer(question, options);
}

// ── 第五刀（2026-09-28）：再放宽一轮 ─────────────────────────────────────────────────────────────
//
// 负责人 2026-09-28 的决定。新放行的类别（只由 2026-09-28 那一版文案覆盖）：
//  · 招聘用途的资料处理与分享：雇主的招聘服务商、招聘系统（ATS）及其关联或集团公司为招聘处理、分享申请资料；
//  · 核实所填信息：学历、工作经历、身份，E-Verify 的告知与确认（核实时要找以前的雇主与学校的，也算）；
//  · 背景调查的其余几种（这一次录用）：信用、药检、驾驶记录、社交媒体审查、定期复查；
//  · at-will（随意雇佣）的确认；
//  · 仲裁协议里的集体诉讼与陪审团弃权（同一段文字里说到仲裁才算）；
//  · AI 分析或评估面试录音；
//  · 与申请相关的电话与 WhatsApp 通知；
//  · 集团公司日后联系；
//  · 只有标题的隐私声明（`privacyNoticeTitle`，正文读不到，只有一个肯定回答）；
//  · 只由放行类别组成的混合（前两刀的条款同意、属实声明也算放行类别）。
//
// 仍交还本人（`KEPT_REFUSALS`）：出售资料或为营销分享资料、生物特征、一般免责／不追责／赔偿（一律不认——
// 仲裁协议里只认集体诉讼与陪审团弃权）、竞业／不招揽／保密协议、医疗健康与残障信息。没有列明的也交还本人：
// 调查式消费者报告（要走访邻居、朋友、同事）、拿录音训练 AI、AI 分析情绪或替雇主做决定、营销电话。
// 同意类一律不认联系现在的雇主、推荐人、同事的话——那一问改由资料里的回答答（本文件最后一段）。
//
// 判据的做法与第三刀相同，只是一段文字可以说到几类：
//  1. 先拒：动作名起头、验证码与登录支付（`WIDENED_ABSOLUTE_DENY`）、仍交还本人的几类、点名雇主与推荐人；
//  2. 认话题（facet）：前几刀的八个话题加第五刀的八个。认得出的说法从文字里抹掉，剩下的文字再过一遍第三刀的
//     「一律不许掺」（`CONSENT_VETO_ALL`）：说到了却不是放行的那种说法（光秃秃的 credit、verify、waive、share、
//     clients……）就不认；
//  3. 归类（family）：同一件事的新旧两个话题归一类（背景调查与信用药检、录音与 AI 评估、短信与电话、日后联系与
//     集团）。只有一类且带着新话题 → 那一个新类别；两类以上 → 混合；只有旧话题 → 不归第五刀（那是前三刀的事，
//     它们不认就照旧交还本人——所以 09-24 那一版的同意覆盖的范围一个字都没变）；
//  4. 逐句：每一句只能是同意、说明、指代或套话（与第三刀同一套），否定句不是同意——at-will、E-Verify、仲裁弃权
//     里那几种固定的 not（「不是劳动合同」「不会拿来预先筛人」「不能提起集体诉讼」）除外。

const WIDENED_KINDS: readonly WidenedConsentKind[] = /* @__PURE__ */ Object.freeze([
  'RECRUITING_DATA_SHARING',
  'INFORMATION_VERIFICATION',
  'SCREENING_CONSENT',
  'AT_WILL_ACKNOWLEDGEMENT',
  'ARBITRATION_WAIVER',
  'AI_INTERVIEW_ANALYSIS',
  'CALL_NOTIFICATION_CONSENT',
  'GROUP_FUTURE_CONTACT',
  'PRIVACY_NOTICE_TITLE',
  'COMBINED_CONSENT',
]);

const EMPLOYER_CONTACT_KINDS: readonly EmployerContactKind[] = /* @__PURE__ */ Object.freeze([
  'EMPLOYER_CONTACT_YES',
  'EMPLOYER_CONTACT_NO',
  'REFERENCE_CONTACT_YES',
  'REFERENCE_CONTACT_NO',
]);

/**
 * 点击策略对「认得回来的那一句」仍然生效的绝对拒绝，第五刀的口径（与 click/policy.ts 的 SIGNED_SENTENCE_* 同口径）。
 * 与前三刀的 `CLICK_ABSOLUTE_DENY` 只差一处：核实所填信息（verify / verification）放行了，那一处换成只拦验证码
 * 一类——verification code／link、verify your email／phone／account、one-time、passcode、OTP、security code。
 */
const WIDENED_ABSOLUTE_DENY =
  /^[^\p{L}\p{N}]*(?:submit|apply|send|next|continue|finish)(?![\p{L}\p{N}_])|\bsign(?:ing)?\s*in\b|\blog(?:ging)?\s*in\b|\blogins?\b|authenticat|payment|\bpay\b|credit card|debit card|billing|card number|cvv|cvc|\botp\b|one[-\s]?time|passcode|\bverification (?:codes?|links?|e-?mails?|texts?|sms|messages?)\b|\bverify (?:your|my|the|this) (?:e-?mail|phone|mobile|number|account|code)|security code|password/iu;

/** 同意类不接的对象：现在的雇主、推荐人、同事与亲友。联系现在的雇主改由资料里的回答答；混在同意里的一律交还本人。 */
const CONSENT_CONTACT_VETO: readonly RegExp[] = [
  /\b(?:current(?:ly)?|present|existing) (?:employer|company|supervisor|manager|boss)(?:s|es)?\b|\b(?:my|your) employer\b/u,
  /\b(?:my|your|the|listed|provided|professional|personal) references\b|\breference (?:check|checks|checking)\b|\breferees?\b/u,
  /\b(?:colleagues?|co-?workers?|famil(?:y|ies)|friends?|neighbou?rs?|associates)\b/u,
];

/** 第五刀认的话题：前几刀的八个（条款、属实与六类同意）加第五刀的八个。 */
type WidenedFacet =
  | 'TERMS'
  | 'TRUTH'
  | 'RECORDING'
  | 'SMS'
  | 'FUTURE'
  | 'MARKETING'
  | 'BACKGROUND'
  | 'ARBITRATION'
  | 'SHARING'
  | 'VERIFICATION'
  | 'SCREENING'
  | 'AT_WILL'
  | 'WAIVER'
  | 'AI_ANALYSIS'
  | 'CALLS'
  | 'GROUP';

// 下面这些说法带 g：只用 `search`（从头找、不改 lastIndex）判有没有，用 `replace` 抹掉。
/** 招聘服务商、招聘系统与第三方（「为招聘」另由 `RECRUITING_CONTEXT` 判）。 */
const SHARING_RECIPIENT =
  /\b(?:(?:recruit(?:ing|ment)|hiring|staffing) )?service providers?\b|\b(?:data )?(?:sub-?)?processors?\b|\bvendors?\b|\bapplicant tracking(?: systems?)?\b|\bats\b|\b(?:recruit(?:ing|ment)|hiring) (?:platforms?|systems?|software|tools?|partners?|providers?|vendors?|agenc(?:y|ies)|firms?)\b|\bpowered by\b|\bthird[- ]part(?:y|ies)\b|\bpartners?\b/gu;
/** 关联公司与集团：没说日后联系时，它们是分享的对象；说了，就是集团公司日后联系。 */
const GROUP_COMPANIES =
  /\b(?:affiliat(?:e|es|ed)(?: (?:companies|entities))?|subsidiar(?:y|ies)|parent compan(?:y|ies)|sister compan(?:y|ies)|group (?:of )?(?:companies|company|entities|entity|members)|(?:other )?(?:companies|entities|brands|businesses) (?:in|within|of|across) (?:the |our |its )?(?:[\p{L}&.'-]+ )?group)\b/gu;
/** 跨境传输（GDPR 表常见）：给集团与服务商用的，算招聘用途的处理。 */
const CROSS_BORDER =
  /\btransfer(?:s|red|ring)?\b[^.?!]{0,80}\b(?:outside|abroad|internationally|cross[- ]border|other countr(?:y|ies)|countries|united states|u\.s\.|eea|european economic area)\b|\b(?:international|cross[- ]border) (?:data )?transfers?\b/gu;
const SHARE_VERB = /\bshar(?:e|es|ed|ing)\b|\bdisclos(?:e|es|ed|ing|ure)\b|\btransfer(?:s|red|ring)?\b/gu;
/** 招聘用途：分享的话里要说到这份申请、招聘或录用（没说的，是另一回事）。 */
const RECRUITING_CONTEXT =
  /\b(?:recruit\w*|hiring|hire|application|applications|applicant|candidacy|candidates?|employment|job|jobs|positions?|roles?|vacanc\w*|talent|interview\w*|opportunit\w*|onboarding|background)\b/u;
/** 核实所填信息：核实的对象要是学历、工作经历、身份、所填信息一类；E-Verify；学校与以前雇主的记录。 */
const VERIFICATION_PHRASE =
  /\bverif(?:y|ies|ied|ying|ication|iable)\b[^.?!]{0,100}?\b(?:information|details|statements?|answers?|responses?|application|education(?:al)?|degrees?|diplomas?|academic|schools?|universit(?:y|ies)|employment|work (?:history|experience)|job history|experience|credentials?|licen[cs]es?|certifications?|identity|background|records?|eligibility|qualifications?|dates?|titles?)\b|\b(?:information|details|statements?|answers?|education(?:al)?|degrees?|academic|employment(?: history)?|work history|credentials?|licen[cs]es?|identity|qualifications?)\b[^.?!]{0,60}?\bverif(?:y|ies|ied|ying|ication)\b|\be-?verify\b|\bemployment eligibility (?:verification|confirmation)\b|\breleas(?:e|ing) (?:of )?(?:any |all |my |your |the )?(?:[\p{L}-]+ ){0,2}(?:information|records?|transcripts?)\b|\b(?:education(?:al)?|academic|school|college|university|employment) records?\b|\b(?:academic|school|college|university|official|educational) transcripts?\b/gu;
/** 核实时要找的人：以前的雇主与学校（现在的雇主、推荐人、同事不在其中）。 */
const VERIFICATION_SOURCES =
  /\b(?:former|previous|past|prior) (?:employers?|supervisors?|managers?)\b|\b(?:schools?|universit(?:y|ies)|colleges?|educational institutions?|licensing (?:boards?|bodies))\b/gu;
/** 背景调查的其余几种（这一次录用）。 */
const SCREENING_PHRASE =
  /\bcredit (?:checks?|reports?|history|histories|background|information|records?|scores?)\b|\bconsumer (?:credit )?reports?\b|\bdrug(?: and alcohol)? (?:tests?|testing|screens?|screening)\b|\b(?:alcohol|substance)(?: abuse)? (?:tests?|testing|screens?|screening)\b|\bmotor vehicle (?:records?|reports?|history|checks?)\b|\bmvrs?\b|\bdriving (?:records?|history|histories|abstracts?|checks?)\b|\bdriver'?s? (?:records?|history|abstracts?)\b|\bsocial media (?:screen(?:ing|s)?|checks?|reviews?|search(?:es)?|background checks?)\b|\bcriminal (?:records?|history|histories|background|convictions?)(?: (?:checks?|search(?:es)?|screen(?:ing|s)?|reports?))?\b|\b(?:periodic|ongoing|continuous|continual|annual|recurring|routine) (?:re-?)?(?:checks?|screen(?:ing|s)?|background checks?|monitoring|reviews?)\b|\bre-?screen(?:ing|s)?\b/gu;
/** 定期复查的另一种说法（在职期间随时查）：只和背景调查一起出现时才算。 */
const DURING_EMPLOYMENT = /\b(?:at any time )?(?:during|throughout) (?:my|your|the) (?:employment|tenure)\b|\bwhile (?:i am|you are) employed\b/gu;
const AT_WILL_PHRASE = /\bat[- ]will\b|\bemployment at will\b/gu;
/** 仲裁协议里的弃权：集体诉讼、集体／代表诉讼、陪审团审理、上法院（只和仲裁一起出现时才算）。 */
const WAIVER_PHRASE =
  /\b(?:class|collective|representative)(?:-| )(?:actions?|arbitrations?|claims?|proceedings?)\b|\bjury(?: trials?)?\b|\btrials? by jury\b|\bcourt\b/gu;
const WAIVE_WORD = /\bwaiv(?:e|es|ed|er|ers|ing)\b/gu;
/** AI 分析或评估：AI 的说法与分析、评估一类的动词（场合另要面试或录音）。 */
const AI_WORD =
  /\b(?:ai|a\.i\.|artificial intelligence|machine learning|automated (?:tools?|systems?|software|technology|analysis|assessments?|evaluations?|scoring)|algorithm(?:s|ic)?)\b/gu;
const ANALYSIS_WORD =
  /\b(?:analy[sz](?:e|es|ed|ing)|analysis|analyses|assess(?:es|ed|ing|ments?)?|evaluat(?:e|es|ed|ing|ions?)|scor(?:e|es|ed|ing)|rank(?:s|ed|ing)?)\b/gu;
const INTERVIEW_OR_RECORDING = /\b(?:interviews?|conversations?|calls?|meetings?|screenings?|sessions?|discussions?|recorded|recordings?|videos?)\b/u;
/** 拿录音训练模型、分析情绪、替雇主做决定：没有列明，交还本人。 */
const AI_VETO = /\bdecisions?\b|\bdecid(?:e|es|ed|ing)\b|\bemotion(?:s|al)?\b|\btrain(?:s|ed|ing)?\b/u;
/** 电话与 WhatsApp（与申请相关的通知）。 */
const CALLS_PHRASE =
  /\b(?:phone|voice|telephone|autodialed|auto-?dialed|automated|pre-?recorded|prerecorded) calls?\b|\bcalls? (?:from|about|regarding)\b|\b(?:call|phone|telephone) (?:me|you)\b|\bcontact (?:me|you) by (?:phone|telephone|whatsapp)\b|\bby (?:phone|telephone)\b|\bwhatsapp\b|\bautodial(?:ed|er|ing)?\b|\bautomatic (?:telephone )?dialing(?: system)?\b|\bvoice ?mails?\b/gu;
/** 电话里说到营销、推销：那不是与申请相关的通知。 */
const CALL_PROMOTION = /\b(?:marketing|telemarketing|deals?|special offers?|promotions?|promotional|discounts?|advertis\w*|coupons?|sales calls?)\b/u;
/** 「pre-recorded calls」里的 recorded 不是面试录音。 */
const PRERECORDED = /\bpre-?recorded\b/gu;
/** 抹掉认得的说法之后仍然不许剩下的：集团以外的「别的公司」。 */
const WIDENED_LEFTOVER_VETO = /\bother (?:companies|entities|businesses|organi[sz]ations)\b|\bsubsidiar|\bgroup (?:companies|entities)\b/u;

const found = (pattern: RegExp, text: string): boolean => text.search(pattern) >= 0;
const erase = (text: string, pattern: RegExp): string => text.replace(pattern, ' ');

/** 整段（套话之外）说到的话题。 */
function facetsOf(text: string): Set<WidenedFacet> {
  const facets = new Set<WidenedFacet>();
  const policyText = text.replace(POLICY_REFERENCE, ' ');
  if (POLICY_NOUN.test(policyText)) facets.add('TERMS');
  if (TRUTH_MIX.test(text)) facets.add('TRUTH');
  const recordingText = erase(text, PRERECORDED);
  if (CONSENT_TOPIC.AI_RECORDING_CONSENT.test(recordingText) && INTERVIEW_CONTEXT.test(recordingText)) facets.add('RECORDING');
  if (CONSENT_TOPIC.SMS_CONSENT.test(text)) facets.add('SMS');
  const future = CONSENT_TOPIC.FUTURE_CONTACT_CONSENT.test(text);
  if (future) facets.add('FUTURE');
  if (CONSENT_TOPIC.MARKETING_CONSENT.test(text)) facets.add('MARKETING');
  const background = CONSENT_TOPIC.BACKGROUND_CHECK_CONSENT.test(text);
  if (background) facets.add('BACKGROUND');
  if (CONSENT_TOPIC.ARBITRATION_AGREEMENT.test(text)) facets.add('ARBITRATION');
  const group = found(GROUP_COMPANIES, text);
  if (group && future) facets.add('GROUP');
  if (found(SHARING_RECIPIENT, text) || found(CROSS_BORDER, text) || (group && !future)) facets.add('SHARING');
  if (found(VERIFICATION_PHRASE, text)) facets.add('VERIFICATION');
  const screening = found(SCREENING_PHRASE, text);
  if (screening || (background && found(DURING_EMPLOYMENT, text))) facets.add('SCREENING');
  if (found(AT_WILL_PHRASE, text)) facets.add('AT_WILL');
  if (found(WAIVER_PHRASE, text)) facets.add('WAIVER');
  if (found(AI_WORD, text) && found(ANALYSIS_WORD, text) && INTERVIEW_OR_RECORDING.test(text)) facets.add('AI_ANALYSIS');
  if (found(CALLS_PHRASE, text)) facets.add('CALLS');
  return facets;
}

/** 一句话说到了哪个（已认出的）话题：比整段的判据宽，只问「这一句在不在讲它」。 */
function sentenceMentions(sentence: string, facets: ReadonlySet<WidenedFacet>): boolean {
  const mentions: Readonly<Record<WidenedFacet, (text: string) => boolean>> = {
    TERMS: (text) => POLICY_NOUN.test(text.replace(POLICY_REFERENCE, ' ')),
    TRUTH: (text) => TRUTH_MIX.test(text),
    RECORDING: (text) => CONSENT_TOPIC.AI_RECORDING_CONSENT.test(erase(text, PRERECORDED)),
    SMS: (text) => CONSENT_TOPIC.SMS_CONSENT.test(text),
    FUTURE: (text) => CONSENT_TOPIC.FUTURE_CONTACT_CONSENT.test(text),
    MARKETING: (text) => CONSENT_TOPIC.MARKETING_CONSENT.test(text),
    BACKGROUND: (text) => CONSENT_TOPIC.BACKGROUND_CHECK_CONSENT.test(text),
    ARBITRATION: (text) => CONSENT_TOPIC.ARBITRATION_AGREEMENT.test(text),
    SHARING: (text) => found(SHARING_RECIPIENT, text) || found(CROSS_BORDER, text) || found(GROUP_COMPANIES, text) || found(SHARE_VERB, text),
    VERIFICATION: (text) => found(VERIFICATION_PHRASE, text),
    SCREENING: (text) => found(SCREENING_PHRASE, text) || found(DURING_EMPLOYMENT, text),
    AT_WILL: (text) => found(AT_WILL_PHRASE, text),
    WAIVER: (text) => found(WAIVER_PHRASE, text) || found(WAIVE_WORD, text),
    AI_ANALYSIS: (text) => found(AI_WORD, text) || found(ANALYSIS_WORD, text),
    CALLS: (text) => found(CALLS_PHRASE, text),
    GROUP: (text) => found(GROUP_COMPANIES, text),
  };
  return [...facets].some((facet) => mentions[facet](sentence));
}

/** 把认得出的说法抹掉；剩下的文字再过第三刀的「一律不许掺」。 */
function unexplained(text: string, facets: ReadonlySet<WidenedFacet>): string {
  let rest = text;
  if (facets.has('SHARING') || facets.has('GROUP')) {
    for (const pattern of [CROSS_BORDER, SHARING_RECIPIENT, GROUP_COMPANIES, SHARE_VERB]) rest = erase(rest, pattern);
  }
  if (facets.has('VERIFICATION')) rest = erase(erase(rest, VERIFICATION_PHRASE), VERIFICATION_SOURCES);
  if (facets.has('SCREENING')) rest = erase(erase(rest, SCREENING_PHRASE), DURING_EMPLOYMENT);
  if (facets.has('AT_WILL')) rest = erase(rest, AT_WILL_PHRASE);
  if (facets.has('WAIVER') && facets.has('ARBITRATION')) rest = erase(erase(rest, WAIVER_PHRASE), WAIVE_WORD);
  return rest;
}

/** 几个话题放在一起说得通吗：弃权要在仲裁协议里，分享要为招聘，营销不许带分享、电话，AI 不许做决定、训练模型。 */
function coherent(text: string, facets: ReadonlySet<WidenedFacet>): boolean {
  if (facets.has('WAIVER') && !facets.has('ARBITRATION')) return false;
  if (facets.has('SHARING') && !RECRUITING_CONTEXT.test(text)) return false;
  if (facets.has('MARKETING') && (facets.has('SHARING') || facets.has('GROUP') || facets.has('CALLS'))) return false;
  if (facets.has('CALLS') && CALL_PROMOTION.test(text)) return false;
  if ((facets.has('RECORDING') || facets.has('AI_ANALYSIS')) && AI_VETO.test(text)) return false;
  return true;
}

/**
 * 这段文字能不能交给第五刀：先拒掉该拒的，再认话题、抹掉认得出的说法、剩下的过一遍否决。拒了就 null。
 * 套话（资费、退订、「详见隐私政策」）不算话题，但否决照样看整段。
 */
function admittedFacets(text: string): ReadonlySet<WidenedFacet> | null {
  if (WIDENED_ABSOLUTE_DENY.test(text)) return null;
  if (keptRefusal(text) || CONSENT_CONTACT_VETO.some((pattern) => pattern.test(text))) return null;
  const substantive = sentences(text).filter((sentence) => !isBoilerplate(sentence)).join(' ');
  const facets = facetsOf(substantive);
  if (facets.size === 0 || !coherent(text, facets)) return null;
  const rest = unexplained(text, facets);
  if (CONSENT_VETO_ALL.some((pattern) => pattern.test(rest)) || WIDENED_LEFTOVER_VETO.test(rest)) return null;
  return facets;
}

function isBoilerplate(sentence: string): boolean {
  return sentence.length <= MAX_BOILERPLATE_LENGTH && CONSENT_BOILERPLATE.some((pattern) => pattern.test(sentence));
}

/** 同一件事的新旧两个话题归一类。 */
type WidenedFamily = 'TERMS' | 'TRUTH' | 'AI' | 'PHONE' | 'FUTURE' | 'MARKETING' | 'SCREEN' | 'ARBITRATION' | 'SHARING' | 'VERIFICATION' | 'AT_WILL';
const FAMILY_OF_FACET: Readonly<Record<WidenedFacet, WidenedFamily>> = /* @__PURE__ */ Object.freeze({
  TERMS: 'TERMS',
  TRUTH: 'TRUTH',
  RECORDING: 'AI',
  AI_ANALYSIS: 'AI',
  SMS: 'PHONE',
  CALLS: 'PHONE',
  FUTURE: 'FUTURE',
  GROUP: 'FUTURE',
  MARKETING: 'MARKETING',
  BACKGROUND: 'SCREEN',
  SCREENING: 'SCREEN',
  ARBITRATION: 'ARBITRATION',
  WAIVER: 'ARBITRATION',
  SHARING: 'SHARING',
  VERIFICATION: 'VERIFICATION',
  AT_WILL: 'AT_WILL',
});
/** 第五刀的新话题 → 它所在的那一类单独出现时的新类别。 */
const KIND_OF_NEW_FACET: Readonly<Partial<Record<WidenedFacet, WidenedConsentKind>>> = /* @__PURE__ */ Object.freeze({
  SHARING: 'RECRUITING_DATA_SHARING',
  VERIFICATION: 'INFORMATION_VERIFICATION',
  SCREENING: 'SCREENING_CONSENT',
  AT_WILL: 'AT_WILL_ACKNOWLEDGEMENT',
  WAIVER: 'ARBITRATION_WAIVER',
  AI_ANALYSIS: 'AI_INTERVIEW_ANALYSIS',
  CALLS: 'CALL_NOTIFICATION_CONSENT',
  GROUP: 'GROUP_FUTURE_CONTACT',
});
/** 标题归哪一类：旧的六类与第五刀的单类新类别各归各的（混合与隐私声明标题不归类）。 */
const FAMILY_OF_KIND: Readonly<Partial<Record<ConsentOnBehalfKind, WidenedFamily>>> = /* @__PURE__ */ Object.freeze({
  AI_RECORDING_CONSENT: 'AI',
  SMS_CONSENT: 'PHONE',
  FUTURE_CONTACT_CONSENT: 'FUTURE',
  MARKETING_CONSENT: 'MARKETING',
  BACKGROUND_CHECK_CONSENT: 'SCREEN',
  ARBITRATION_AGREEMENT: 'ARBITRATION',
  RECRUITING_DATA_SHARING: 'SHARING',
  INFORMATION_VERIFICATION: 'VERIFICATION',
  SCREENING_CONSENT: 'SCREEN',
  AT_WILL_ACKNOWLEDGEMENT: 'AT_WILL',
  ARBITRATION_WAIVER: 'ARBITRATION',
  AI_INTERVIEW_ANALYSIS: 'AI',
  CALL_NOTIFICATION_CONSENT: 'PHONE',
  GROUP_FUTURE_CONTACT: 'FUTURE',
});

/** 话题 → 类别：两类以上是混合；只有一类时要带着第五刀的新话题（只有旧话题的是前三刀的事）。 */
function kindOfFacets(facets: ReadonlySet<WidenedFacet>): WidenedConsentKind | null {
  const families = new Set([...facets].map((facet) => FAMILY_OF_FACET[facet]));
  if (families.size >= 2) return 'COMBINED_CONSENT';
  const fresh = [...facets].flatMap((facet) => {
    const kind = KIND_OF_NEW_FACET[facet];
    return kind === undefined ? [] : [kind];
  });
  return fresh.length === 1 ? fresh[0]! : null;
}

/**
 * 第五刀认得的几种固定的 not：它们是在陈述，不是拒绝。只在说到那个话题的整段里抹掉——at-will 的「不是劳动合同」
 * 「不是固定期限」「只能书面更改」，E-Verify 的「不会拿来预先筛人」，仲裁的「不能提起或参加集体诉讼」。
 */
const BENIGN_NOT: readonly (readonly [WidenedFacet, RegExp])[] = [
  [
    'AT_WILL',
    /\b(?:is|are|was|will|shall|should|does|do) not (?:be )?(?:an? )?(?:create[sd]?|constitute[sd]?|form(?:s|ed)?|contracts?|guarantees?|promises?|intended to (?:create|constitute))\b|\bnot (?:an? )?(?:contract|guarantee|promise) (?:of|for) (?:employment|continued employment)\b|\bnot for (?:a|any) (?:definite|specified|fixed|particular) (?:period|term|duration|length of time)\b|\bcannot be (?:changed|altered|modified|amended)\b/gu,
  ],
  ['VERIFICATION', /\b(?:will|may|does|do|shall|cannot|can not) not (?:be )?used? (?:to|for) (?:pre-?screen\w*|screen\w*)\b|\bnot (?:be )?used (?:to|for) (?:pre-?screen\w*)\b/gu],
  [
    'WAIVER',
    /\b(?:cannot|can not|may not|will not|shall not|won't|can't) (?:bring|participate|pursue|join|file|serve|proceed)\b[^.?!]{0,60}?\b(?:class|collective|representative|jury|court)\w*/gu,
  ],
];

function widenedNegated(sentence: string, facets: ReadonlySet<WidenedFacet>): boolean {
  let rest = sentence;
  for (const [facet, pattern] of BENIGN_NOT) if (facets.has(facet)) rest = erase(rest, pattern);
  return negated(rest);
}

/**
 * 第五刀多认的几种同意说法（与前三刀的 `CONSENT_ASSENT` 一起判；那一张不动：动了就会扩大旧版本同意覆盖的范围）。
 * 单列一张、不在模块顶层展开旧的那张：顶层的展开摇不掉，只用得到扫描那一半的 worker 包会把两张都带上。
 */
const WIDENED_ASSENT_EXTRA: readonly RegExp[] = [
  /\bi (?:hereby |also |fully |expressly )*(?:certify|attest|affirm|declare|confirm|represent)\b/u,
  /\byou (?:hereby |also |expressly )?(?:certify|confirm|affirm|attest|grant|give|allow|permit)\b/u,
  /^(?:(?:may|can|could) we|is it (?:ok|okay|alright|all right) (?:if|for) (?:we|us))\b[^?]*\b(?:verify|check|run|conduct|perform|obtain|request|share|transfer|disclose|process|call|phone|analy[sz]e|evaluate|assess|screen|use|review)\b/u,
  /^(?:do|would|will|can|could|may|are) you\b[^?]*\b(?:permission|authori[sz]ation|consent|submit|undergo)\b/u,
  /\bi (?:hereby |also )?(?:give|grant) (?:[\p{L}'.-]+ ){0,3}(?:my )?(?:permission|consent|authori[sz]ation)\b/u,
];

function widenedSentence(sentence: string, facets: ReadonlySet<WidenedFacet>): ConsentSentence | null {
  if (isBoilerplate(sentence)) return 'BOILERPLATE';
  if (widenedNegated(sentence, facets)) return null;
  if (!sentenceMentions(sentence, facets)) return CONSENT_POINTER.test(sentence) ? 'POINTER' : null;
  const assent = CONSENT_ASSENT.some((pattern) => pattern.test(sentence)) || WIDENED_ASSENT_EXTRA.some((pattern) => pattern.test(sentence));
  return assent ? 'ASSENT' : 'CONTEXT';
}

/**
 * 第五刀：一句话（勾选框的标签、选择题的题面或选项）是不是新放行的某一类（或只由放行类别组成的混合）的整句
 * 同意；都不是就 null。前三刀认得出的，这里一律不答（只有旧话题的归不到第五刀）。
 */
export function widenedConsentKind(label: string): WidenedConsentKind | null {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_CHECKBOX_LABEL_LENGTH) return null;
  // 前三刀认得出的（旧版本的同意就覆盖），第五刀不另答：两边认的是互不相交的两堆话。
  if (signOnBehalfCheckboxKind(label) !== null || consentOnBehalfKind(label) !== null) return null;
  const facets = admittedFacets(text);
  if (facets === null) return null;
  const kind = kindOfFacets(facets);
  if (kind === null) return null;
  const roles = sentences(text).map((sentence) => widenedSentence(sentence, facets));
  if (roles.includes(null)) return null;
  return roles.includes('ASSENT') || (roles.includes('POINTER') && roles.includes('CONTEXT')) ? kind : null;
}

/**
 * 第五刀的标题：同一类、一句话（「E-Verify Acknowledgement」「Credit Check Authorization」「At-Will Employment」）。
 * 它自己不是同意：只在选项本身是这一类的整句同意时，才让那一项算数。混合不算标题。
 */
export function widenedTopicTitle(label: string): WidenedConsentKind | null {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_TITLE_LENGTH || sentences(text).length !== 1) return null;
  const facets = admittedFacets(text);
  if (facets === null || widenedNegated(text, facets)) return null;
  const kind = kindOfFacets(facets);
  return kind === 'COMBINED_CONSENT' ? null : kind;
}

/** 题面是哪一类的标题（旧的六类或第五刀的单类新类别）：选项要在同一类里才算数。 */
function titleFamily(question: string): WidenedFamily | null {
  const kind = consentTopicTitle(question) ?? widenedTopicTitle(question);
  return kind === null ? null : FAMILY_OF_KIND[kind] ?? null;
}

/**
 * 只有标题的隐私声明（负责人 2026-09-28 列明）：「Applicant Privacy Notice」一类的名字，正文读不到，只配一个
 * 肯定回答。名字前面最多四个词（公司、地区、申请人一类），后面可以跟「for applicants」「acknowledgement」。
 * 说到别的类别、出售、否定的，都不算。
 */
const PRIVACY_NOTICE_NAME =
  /^(?:(?:please )?(?:read|review|see)(?: and acknowledge)? (?:the |our |this )?)?(?:[\p{L}\p{N}&.'-]+ ){0,4}?(?:(?:privacy|data protection|data privacy|personal (?:data|information)) (?:notices?|polic(?:y|ies)|statements?|disclosures?)|notice at collection)(?: (?:for|to) (?:job )?(?:applicants|candidates|california (?:applicants|residents|job applicants)))?(?: (?:acknowledg(?:e)?ment|acknowledge|consent))?$/u;
const MAX_PRIVACY_TITLE_LENGTH = 120;

export function privacyNoticeTitle(label: string): boolean {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_PRIVACY_TITLE_LENGTH || !PRIVACY_NOTICE_NAME.test(text)) return false;
  if (CLICK_ABSOLUTE_DENY.test(text) || negated(text)) return false;
  if (keptRefusal(text) || CONSENT_CONTACT_VETO.some((pattern) => pattern.test(text))) return false;
  const facets = facetsOf(text);
  facets.delete('TERMS');
  return facets.size === 0 && !CONSENT_VETO_ALL.some((pattern) => pattern.test(text));
}

/** 题面没说任何一类、也没掺别的授权：可以只看选项。 */
function neutralQuestion(text: string): boolean {
  return text.length <= MAX_CHECKBOX_LABEL_LENGTH && !OTHER_AUTHORIZATION.test(text) && !POLICY_NOUN.test(text) &&
    !CLICK_ABSOLUTE_DENY.test(text) && !negated(text) && !keptRefusal(text) &&
    !CONSENT_CONTACT_VETO.some((pattern) => pattern.test(text)) && facetsOf(text).size === 0;
}

/**
 * 第五刀的选择题该选哪一项：
 *  · 题面本身是新类别的整句同意：恰好一项是肯定回答（或本身是同一类的整句同意）；
 *  · 题面是只有标题的隐私声明：恰好一项是肯定回答，其余只能是否定回答或占位项；
 *  · 题面是某一类的标题、或不沾任何一类的一句话：恰好一项本身是（同一类的）新类别整句同意，其余只能是否定回答。
 * 零项或多项都不选。
 */
function widenedAnswer(question: string, options: readonly string[]): Readonly<{ kind: WidenedConsentKind; index: number }> | null {
  const asked = widenedConsentKind(question);
  if (asked !== null) {
    const hits = options.flatMap((option, index) =>
      isAffirmativeAnswerFor(asked, option) || widenedConsentKind(option) === asked ? [index] : []);
    return hits.length === 1 ? { kind: asked, index: hits[0]! } : null;
  }
  if (privacyNoticeTitle(question)) {
    const hits = options.flatMap((option, index) => (isAffirmativeAnswer(option) ? [index] : []));
    if (hits.length !== 1) return null;
    const index = hits[0]!;
    return options.every((option, other) => other === index || CONSENT_NEGATIVE.test(normalize(option)))
      ? { kind: 'PRIVACY_NOTICE_TITLE', index }
      : null;
  }
  const family = titleFamily(question);
  if (family === null && !neutralQuestion(normalize(question))) return null;
  const kinds = options.map((option) => widenedConsentKind(option));
  const hits = kinds.flatMap((kind, index) =>
    kind !== null && (family === null || FAMILY_OF_KIND[kind] === family) ? [index] : []);
  if (hits.length !== 1) return null;
  const index = hits[0]!;
  const othersDecline = options.every((option, other) => other === index || CONSENT_NEGATIVE.test(normalize(option)));
  return othersDecline ? { kind: kinds[index]!, index } : null;
}

// ── 能不能联系现在的雇主（2026-09-28）：资料里的一问 ──────────────────────────────────────────────
//
// 负责人 2026-09-28 的决定：联系现在的雇主不再一律交还本人，改成资料里问一次「可以联系你现在的雇主吗？」（是／否，
// 默认没答）。申请表上问能不能联系他现在的雇主的（是非题、下拉，或一句「I authorize … to contact my current
// employer」的勾选框），按他的回答答；没答就照旧交还本人。
//
// 以前的雇主与推荐人：题目**只问**他们（「May we contact your previous employers?」「May we contact your
// references?」）时，照他对现在雇主的同一个回答答——现在的雇主是最敏感的那一个，他答了「可以」，以前的雇主与推荐人
// 自然也可以；他答了「不可以」，我们不替他去说可以。题目把雇主和别的事（背景调查、信用、核实、同事、学校、亲友）
// 混在一起问的，一律交还本人；同时问现在和以前的，按现在的雇主算。
//
// 不看同意书（它不是代填授权里的一类），但照样只在运行时包放行 `sign-on-behalf` 时才答（远程可关）；点击当下题面与
// 选项各认一遍，答的方向写在类别里（`*_YES` 只认肯定回答，`*_NO` 只认否定回答）。

/** 资料里那一问的回答。 */
export type EmployerContactAnswer = 'YES' | 'NO';
/** 问的是谁：现在的雇主，还是以前的雇主或推荐人。 */
export type EmployerContactSubject = 'CURRENT' | 'PAST';

const MAX_EMPLOYER_CONTACT_LENGTH = 300;
const CURRENT_EMPLOYER =
  /\b(?:(?:current(?:ly)?|present|existing)(?:(?: and| or|\/| &) (?:former|previous|past|prior))?|(?:former|previous|past|prior)(?: and| or|\/| &) (?:current|present)) (?:employers?|company|companies|supervisors?|managers?|boss(?:es)?)\b|\b(?:my|your) employer\b|\bemployer (?:you|i) (?:currently )?work for\b/u;
const PAST_EMPLOYERS_OR_REFERENCES =
  /\b(?:former|previous|past|prior|earlier) (?:employers?|supervisors?|managers?|companies|bosses)\b|\breferences?\b|\breferees?\b/u;
const CONTACT_VERB =
  /\bcontact(?:s|ed|ing)?\b|\breach(?:ing)? out to\b|\bget(?:ting)? in touch with\b|\bspeak(?:ing)? (?:with|to)\b|\btalk(?:ing)? (?:with|to)\b|\bcall(?:s|ed|ing)?\b|\bcheck(?:ing)? with\b|\breference checks?\b|\b(?:request|obtain|seek)(?:s|ed|ing)? (?:a |an )?references?\b/u;
/** 联系雇主时说的用途：核实在职、要推荐（这几句本身不是另一件事）。 */
const EMPLOYER_PURPOSE =
  /\b(?:to|in order to) (?:verify|confirm) (?:your|my|the) (?:employment|work history|dates? of employment|position|job title|title|role)\b|\bfor (?:a |an )?(?:references?|reference checks?|employment verification|verification)(?: purposes)?\b|\bas (?:a |an )?references?\b|\b(?:regarding|about|concerning) (?:your|my) (?:employment|performance|work)\b/gu;
/** 雇主之外的人：同事、学校、亲友、客户。 */
const OTHER_PEOPLE = /\b(?:colleagues?|co-?workers?|schools?|universit\w*|famil(?:y|ies)|friends?|neighbou?rs?|clients?|customers?)\b/u;
/** 正面的许可（勾选框那句话、选项里的整句）：他本人说可以联系。 */
const EMPLOYER_PERMISSION =
  /\bi (?:hereby |also )?(?:authori[sz]e|agree|consent|give (?:[\p{L}'.-]+ ){0,2}(?:permission|consent)|allow|permit)\b|\byou (?:may|can|have my permission to)\b|^(?:yes[,!.]? )?(?:please )?(?:feel free to )?contact\b|^yes\b/u;
/** 问句（或标题）：问的是能不能联系，不是他已经同意了。 */
const EMPLOYER_QUESTION = /\?$|^(?:may|can|could|do|would|will|is|are|should|shall)\b/u;
/** 「不可以」的闭集（整项逐字）：No、No thanks、Not at this time、I do not authorize…；占位项不算回答。 */
const EMPLOYER_NEGATIVE =
  /^(?:no|no,? (?:thank you|thanks)|not (?:at this time|now|yet)|no,? (?:please )?(?:do not|don't) contact (?:them|(?:my|the) (?:(?:current|present|former|previous|past|prior) )?(?:employers?|supervisors?|managers?|references?))|(?:i )?(?:do not|don't) (?:authori[sz]e|consent|agree|give (?:you )?permission)(?: to (?:this|that|it))?)[.!]?$/u;

type EmployerContactForm = Readonly<{ subject: EmployerContactSubject; form: 'QUESTION' | 'STATEMENT' }>;

/** 这句话是在问（或正面地许可）联系他现在的雇主、以前的雇主或推荐人吗；掺了别的事就 null。 */
function employerContactForm(label: string): EmployerContactForm | null {
  const text = normalize(label);
  if (text.length === 0 || text.length > MAX_EMPLOYER_CONTACT_LENGTH || WIDENED_ABSOLUTE_DENY.test(text)) return null;
  if (keptRefusal(text) || OTHER_PEOPLE.test(text)) return null;
  const core = erase(text, EMPLOYER_PURPOSE);
  // 只问联系：掺了任何一类同意的话题（背景调查、信用、核实、分享……）或别的授权，就不是这一问。前四条「点名他人」
  // 的否决不用——这一问问的就是他们（见 `CONSENT_VETO_ALL` 头上那句）。
  if (facetsOf(core).size > 0 || CONSENT_VETO_ALL.slice(4).some((pattern) => pattern.test(core))) return null;
  if (!CONTACT_VERB.test(core)) return null;
  const subject: EmployerContactSubject | null = CURRENT_EMPLOYER.test(core) ? 'CURRENT' : PAST_EMPLOYERS_OR_REFERENCES.test(core) ? 'PAST' : null;
  if (subject === null) return null;
  const parts = sentences(text);
  for (const sentence of parts) {
    if (isBoilerplate(sentence)) continue;
    if (negated(sentence)) return null;
  }
  const asking = parts.some((sentence) => EMPLOYER_QUESTION.test(sentence));
  const granting = parts.some((sentence) => EMPLOYER_PERMISSION.test(sentence));
  return { subject, form: granting && !asking ? 'STATEMENT' : 'QUESTION' };
}

/** 题面问的是谁（现在的雇主 → CURRENT；以前的雇主或推荐人 → PAST）；不是这一问就 null。 */
export function employerContactSubject(label: string): EmployerContactSubject | null {
  return employerContactForm(label)?.subject ?? null;
}

function employerContactKind(subject: EmployerContactSubject, answer: EmployerContactAnswer): EmployerContactKind {
  if (subject === 'CURRENT') return answer === 'YES' ? 'EMPLOYER_CONTACT_YES' : 'EMPLOYER_CONTACT_NO';
  return answer === 'YES' ? 'REFERENCE_CONTACT_YES' : 'REFERENCE_CONTACT_NO';
}

function subjectOfKind(kind: EmployerContactKind): EmployerContactSubject {
  return kind === 'EMPLOYER_CONTACT_YES' || kind === 'EMPLOYER_CONTACT_NO' ? 'CURRENT' : 'PAST';
}

function answerOfKind(kind: EmployerContactKind): EmployerContactAnswer {
  return kind === 'EMPLOYER_CONTACT_YES' || kind === 'REFERENCE_CONTACT_YES' ? 'YES' : 'NO';
}

/** 一个选项是不是这一向的回答：「可以」认肯定回答与正面许可同一对象的整句；「不可以」只认否定回答的闭集。 */
function employerOptionAnswers(option: string, subject: EmployerContactSubject, answer: EmployerContactAnswer): boolean {
  const text = normalize(option);
  if (answer === 'NO') return EMPLOYER_NEGATIVE.test(text);
  if (isAffirmativeAnswer(option) || CONSENT_AFFIRMATIVE.test(text)) return true;
  const form = employerContactForm(option);
  return form !== null && form.form === 'STATEMENT' && form.subject === subject;
}

/**
 * 能不能联系雇主的选择题，照他的回答该选哪一项：恰好一项是这一向的回答才选（「Yes, after an offer」一类有条件的
 * 说法不算「可以」）。题面不是这一问、或零项／多项，就 null（交还本人）。
 */
export function employerContactAnswer(
  question: string,
  options: readonly string[],
  answer: EmployerContactAnswer,
): Readonly<{ kind: EmployerContactKind; index: number }> | null {
  const subject = employerContactSubject(question);
  if (subject === null) return null;
  const hits = options.flatMap((option, index) => (employerOptionAnswers(option, subject, answer) ? [index] : []));
  return hits.length === 1 ? { kind: employerContactKind(subject, answer), index: hits[0]! } : null;
}

/**
 * 单个勾选框：只有那句话是他本人正面的许可（「I authorize Acme to contact my current employer」），而他在资料里
 * 答了「可以」，才勾。答「不可以」、没答、或者那句话是「请不要联系」，都不勾（交还本人，不替他留一个空着的决定）。
 */
export function employerContactCheckboxKind(label: string, answer: EmployerContactAnswer | undefined): EmployerContactKind | null {
  if (answer !== 'YES') return null;
  const form = employerContactForm(label);
  return form === null || form.form !== 'STATEMENT' ? null : employerContactKind(form.subject, 'YES');
}

// ── 点击当下认回来的那几句（click/policy.ts 的 `SigningGrammar` 用）──────────────────────────────────

/**
 * 这一段文字认得回来是这一类（整句）：条款同意／属实声明按前两刀，六类同意按第三刀，新类别按第五刀；
 * 只有标题的隐私声明认那个名字；联系雇主：「可以」认问句与正面的许可，「不可以」只认问句——一句「you may contact
 * my current employer」永远不会被当成「不可以」那一向的依据。
 */
export function signOnBehalfStates(text: string, kind: SignOnBehalfChoiceKind): boolean {
  if (isEmployerContactKind(kind)) {
    const form = employerContactForm(text);
    if (form === null || form.subject !== subjectOfKind(kind)) return false;
    return answerOfKind(kind) === 'YES' || form.form === 'QUESTION';
  }
  if (kind === 'PRIVACY_NOTICE_TITLE') return privacyNoticeTitle(text);
  if (kind === 'TERMS_CONSENT' || kind === 'TRUTH_ATTESTATION') return signOnBehalfCheckboxKind(text) === kind;
  if (CONSENT_KINDS.includes(kind as ThirdCutConsentKind)) return consentOnBehalfKind(text) === kind;
  return widenedConsentKind(text) === kind;
}

/**
 * 题面认得回来：整句是这一类；同意类另认同一类的标题（第三刀只认它自己的标题，一字不动；第五刀认同一族的标题——
 * 「Background Check」下面的信用调查同意）；联系雇主认同一个对象的问句或许可。
 */
export function signOnBehalfAsks(text: string, kind: SignOnBehalfChoiceKind): boolean {
  if (isEmployerContactKind(kind)) return employerContactSubject(text) === subjectOfKind(kind);
  if (signOnBehalfStates(text, kind)) return true;
  if (CONSENT_KINDS.includes(kind as ThirdCutConsentKind)) return consentTopicTitle(text) === kind;
  const family = isConsentKind(kind) ? FAMILY_OF_KIND[kind] : undefined;
  return family !== undefined && titleFamily(text) === family;
}

/** 这一类的回答：联系雇主按方向（肯定回答或否定回答的闭集）；其余是肯定回答（同意类多认几种说法）。 */
export function signOnBehalfAnswers(kind: SignOnBehalfChoiceKind, text: string): boolean {
  if (isEmployerContactKind(kind)) return employerOptionAnswers(text, subjectOfKind(kind), answerOfKind(kind));
  return isAffirmativeAnswerFor(kind, text);
}

/**
 * 按类别在一道题里挑那一项（写入期撞真实菜单时用）：联系雇主按类别里写的方向答；其余按合并判据答，答出来的
 * 必须正是这一类。挑不出、或挑出来的是别的类别，就 null。
 */
export function signOnBehalfAnswerFor(kind: SignOnBehalfChoiceKind, question: string, options: readonly string[]): number | null {
  if (isEmployerContactKind(kind)) {
    const chosen = employerContactAnswer(question, options, answerOfKind(kind));
    return chosen !== null && chosen.kind === kind ? chosen.index : null;
  }
  const chosen = signOnBehalfChoiceAnswer(question, options);
  return chosen !== null && chosen.kind === kind ? chosen.index : null;
}

// ── 代填授权覆盖哪几类（2026-09-28）──────────────────────────────────────────────────────────────
//
// 负责人 2026-09-28 的决定：勾选框只是一句话，每一类写在隐私政策里带版本号的那一节（版本与同意书相同）；范围一改，那一节
// 与同意书的版本号一起升，旧版本的同意不覆盖新加的类别——而且只有当前版本算数：同意过旧版本的，按没同意处理（浮层请他
// 一键同意当前版本）。所以这里没有「哪一版覆盖哪几类」的表，只有「当前版本覆盖哪几类」。

/**
 * 全部类别（签名栏两格、条款与声明、同意类、联系雇主）。逐项写出来而不是从别的表展开：顶层的展开摇不掉，只用得到扫描
 * 那一半的 worker 包会把它带上（`tests/consent-round-5-classifier.test.ts` 钉住它与内核的条目键表逐项相等）。
 */
export const ALL_SIGN_ON_BEHALF_KINDS: readonly SignOnBehalfKind[] = /* @__PURE__ */ Object.freeze([
  'TERMS_CONSENT', 'TRUTH_ATTESTATION', 'SIGNATURE_NAME', 'SIGNATURE_DATE',
  'AI_RECORDING_CONSENT', 'SMS_CONSENT', 'FUTURE_CONTACT_CONSENT', 'MARKETING_CONSENT', 'BACKGROUND_CHECK_CONSENT', 'ARBITRATION_AGREEMENT',
  'RECRUITING_DATA_SHARING', 'INFORMATION_VERIFICATION', 'SCREENING_CONSENT', 'AT_WILL_ACKNOWLEDGEMENT', 'ARBITRATION_WAIVER',
  'AI_INTERVIEW_ANALYSIS', 'CALL_NOTIFICATION_CONSENT', 'GROUP_FUTURE_CONTACT', 'PRIVACY_NOTICE_TITLE', 'COMBINED_CONSENT',
  'EMPLOYER_CONTACT_YES', 'EMPLOYER_CONTACT_NO', 'REFERENCE_CONTACT_YES', 'REFERENCE_CONTACT_NO',
]);

/**
 * 同意了当前版本的代填授权，插件可以以他的名义代填的类别：除「能不能联系雇主」之外的每一类（那一问看资料里的回答，
 * `employerContactKinds`）。没同意、同意的是旧版本、读不到，一类都不行。
 */
export const SIGNING_CONSENT_KINDS: readonly SignOnBehalfKind[] = /* @__PURE__ */ Object.freeze([
  'TERMS_CONSENT', 'TRUTH_ATTESTATION', 'SIGNATURE_NAME', 'SIGNATURE_DATE',
  'AI_RECORDING_CONSENT', 'SMS_CONSENT', 'FUTURE_CONTACT_CONSENT', 'MARKETING_CONSENT', 'BACKGROUND_CHECK_CONSENT', 'ARBITRATION_AGREEMENT',
  'RECRUITING_DATA_SHARING', 'INFORMATION_VERIFICATION', 'SCREENING_CONSENT', 'AT_WILL_ACKNOWLEDGEMENT', 'ARBITRATION_WAIVER',
  'AI_INTERVIEW_ANALYSIS', 'CALL_NOTIFICATION_CONSENT', 'GROUP_FUTURE_CONTACT', 'PRIVACY_NOTICE_TITLE', 'COMBINED_CONSENT',
]);

/** 资料里那一问答了什么，就只放行那一向的两类（现在的雇主、以前的雇主与推荐人）；没答一类都不放。 */
export function employerContactKinds(answer: EmployerContactAnswer | null | undefined): readonly EmployerContactKind[] {
  if (answer === 'YES') return ['EMPLOYER_CONTACT_YES', 'REFERENCE_CONTACT_YES'];
  if (answer === 'NO') return ['EMPLOYER_CONTACT_NO', 'REFERENCE_CONTACT_NO'];
  return [];
}

// ── D7（2026-10-04 负责人）：数据同意页 ──────────────────────────────────────────────────────────────
//
// Jobvite 的「Data Consent」：申请表之前先在「Location of Residence and Language」里选一项，每一项是一份隐私条款（按居住地
// 与语言分），选中之后网站多半当场自己提交、整页跳到申请表。负责人决定：在代填授权之下可以替他选——选的是他资料里的居住国
// 那一项（dict/consentGate.ts）。这里只判那一项本身干不干净。

/**
 * 数据同意页上的一个「居住地与语言」选项能不能由插件替他选：选项就是一份隐私条款（「Global Acme Candidate Privacy Policy -
 * English」）或一个地方（「United States - English」）。掺了任何另外的授权（营销、短信、人才库、背景调查……）或同意类的话题
 * 就不选、交还本人。
 */
export function consentGateOptionClean(option: string): boolean {
  const text = normalize(option);
  return text !== '' && text.length <= MAX_SIGNATURE_LABEL_LENGTH && !OTHER_AUTHORIZATION.test(text) && !mentionsConsentTopic(text);
}
