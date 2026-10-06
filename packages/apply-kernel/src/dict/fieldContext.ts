/**
 * 要看同一节、同一个控件的选项才知道问的是什么的几种题面（2026-09-28，通用路在十张公司自建申请页上量出来的）。
 *
 * 纯文本判据，与 `dict/guards.ts` 同一个姿势：这里只回答「这句话是不是那一种」，同一节里还有什么由
 * engine 看。写不写、写什么仍由计划期的每一道守卫决定。
 */

import { normalizeGuardText } from './guards.ts';

/**
 * 光秃秃的「名字」一词：英文 Name、德文 Name、法文 Nom、西文 Nombre、荷文 Naam、意／葡文 Nome，可带「你的」。
 *
 * 规则把它认成全名（generic.json 里低于填写门槛的那一步），但一张表上它与别的姓名栏同节时意思就变了：德文
 * 「Vorname / Name」里它是姓，西文「Nombre / Apellidos」、法文「Prénom / Nom」同理；落在别人或某个机构的那一节里
 * 是那个人／那个机构的名字（`describesAnotherParty`）——见 engine 的 `contextualKeys`。
 */
const BARE_NAME = /^(?:(?:your|dein|ihr|votre|ton|tu|su|uw|il\s+tuo|seu)\s+)?(?:name|nom|nombre|naam|nome)$/u;

export function isBareNameLabel(label: string): boolean {
  return BARE_NAME.test(normalizeGuardText(label));
}

/**
 * 别人或某个机构的那一节：推荐人、证明人、紧急联系人、担保人、亲属、主管，以及学校、雇主。光秃秃的「Name」落在
 * 这一节里是那个人／那个机构的名字，不是申请人的（厂商共用那条「Full name」规则的注释早就写过：公司名、学校名、
 * 推荐人姓名上同样叫 Name，认错一个写进去的就是别人的资料）。
 *
 * 整词比。不收「company」「organization」「education」「employment」这类词：它们常常就是岗位名或整张申请表的标题
 * （「Employment Application」），收了会把申请人自己的姓名栏也挡掉。挡错的一边只是少填一栏。
 */
const OTHER_PARTY_CONTEXT =
  /(?<!\p{L})(?:references?|referees?|referrals?|referred|emergency|next\s+of\s+kin|guarantors?|guardians?|spouse|beneficiar(?:y|ies)|relatives?|supervisors?|employers?|schools?|universit(?:y|ies)|colleges?|institutions?|referenz(?:en)?|notfall\p{L}*|angehörig\p{L}*|arbeitgeber\p{L}*|schule|hochschule|universität|r[ée]f[ée]rences?|urgence|employeur|[ée]cole|universit[ée]|referencias?|emergencia|empleador|escuela|universidad)(?!\p{L})/iu;

export function describesAnotherParty(caption: string): boolean {
  return OTHER_PARTY_CONTEXT.test(caption.normalize('NFKC'));
}

/**
 * 光秃秃的「Job Title」：经历那一段里它是现任职位（D. E. Shaw 与「Employer Name」并排），单独一栏时也可能在问
 * 申请的是哪个岗位。所以 engine 只在同一节里也有现任公司那一栏时才填它。
 */
const BARE_JOB_TITLE = /^(?:your\s+)?job\s+title$/u;

export function isBareJobTitleLabel(label: string): boolean {
  return BARE_JOB_TITLE.test(normalizeGuardText(label));
}

/**
 * 「I identify as」「How do you identify?」：题面没说是哪一档自我认同。Zalando 的必填下拉就是这一句，选项是
 * Man / Woman / Non-binary / Prefer not to say。只有选项全是性别的说法时，engine 才按性别那一档读（`isGenderAnswerSet`）。
 */
const BARE_IDENTITY_PROMPT = /^(?:i\s+identify\s+as|how\s+do\s+you\s+identify\??|what\s+do\s+you\s+identify\s+as\??)$/u;

export function isBareIdentityPrompt(label: string): boolean {
  return BARE_IDENTITY_PROMPT.test(normalizeGuardText(label));
}

/** 性别题的选项说法（闭集）。「Prefer not to say」一类与「自行描述」一类也在，因为那是性别题的法定选项。 */
const GENDER_ANSWER =
  /^(?:(?:a\s+)?(?:man|woman|male|female)|non[-\s]?binary|genderqueer|gender[-\s]?(?:non[-\s]?conforming|fluid|diverse|queer)|agender|two[-\s]?spirit|other|not\s+listed|(?:i\s+)?prefer\s+(?:not\s+to\s+(?:say|answer|disclose)|to\s+self[-\s]?describe)|(?:i\s+)?(?:decline|choose\s+not)\s+to\s+(?:say|answer|self[-\s]?identify|disclose)|(?:prefer\s+to\s+)?self[-\s]?describe|i\s+don['’]?t\s+wish\s+to\s+answer)$/u;

/**
 * 这一组选项全是性别题的说法，而且男、女两项都在（只有「Other」「Prefer not to say」不算）。
 * 空文字与占位项（「Select…」「---」）不计。
 */
export function isGenderAnswerSet(options: readonly string[]): boolean {
  const texts = options
    .map((text) => normalizeGuardText(text).replace(/[.。]+$/u, ''))
    .filter((text) => text !== '' && !/^(?:-+|select\b.*|choose\b.*|please\s+select\b.*)$/u.test(text));
  if (texts.length < 2 || !texts.every((text) => GENDER_ANSWER.test(text))) return false;
  return texts.some((text) => /^(?:a\s+)?(?:man|male)$/u.test(text)) && texts.some((text) => /^(?:a\s+)?(?:woman|female)$/u.test(text));
}

/**
 * 光秃秃的「Country Code」一类：可能是电话的国际区号，也可能是在问 ISO 国家码。只有它的选项看起来是区号
 * （`Germany (+49)`、`+1`）时才算区号控件（`looksLikeCallingCodeOptions`）；「Phone country code」「Dial code」
 * 这种说到电话的由 `dict/guards.ts` 的 PHONE_COUNTRY_CODE 认。
 */
const BARE_COUNTRY_CODE = /^(?:(?:phone|mobile|tel(?:ephone)?)\s+)?(?:country|international)\s+code$|^(?:dial(?:l?ing)?|calling)\s+code$|^(?:vorwahl|l[äa]ndervorwahl|indicatif(?:\s+(?:t[ée]l[ée]phonique|pays))?|prefijo(?:\s+(?:telef[óo]nico|internacional))?)$/u;

export function isBareCountryCodeLabel(label: string): boolean {
  return BARE_COUNTRY_CODE.test(normalizeGuardText(label));
}

/** 一个选项的国际区号（`Germany (+49)` → `49`、`+1` → `1`、`United States +1` → `1`）；看不出就 null。 */
export function callingCodeOfOption(text: string): string | null {
  const match = /(?:^|[\s(（])\+\s?(\d{1,4})(?:[\s)）-]|$)/u.exec(text.normalize('NFKC'));
  return match === null ? null : match[1]!;
}

/**
 * 只属于一个国家的国际区号 → 那个国家（ISO 3166-1 alpha-2）。另一方小到可以忽略的也算（+39 的梵蒂冈、+47 的斯瓦尔巴、
 * +358 的奥兰）。几国共用的区号（+1 北美编号计划、+7 俄哈、+44 英国与海峡群岛、+61 澳大利亚与圣诞岛、+262、+590……）
 * **不收**：它们照旧按居住国判。
 *
 * 2026-10-01 argoland #698 起档案电话可以是任何国家的号码；「地址在美国、手机 +86」的留学生最常见。要搜的区号框
 * （Workday 的 Country Phone Code）从前只按居住国拼「国名 (+区号)」，这些人永远搜不到。区号本身就说明了国家的，
 * 按区号的国家搜（`engine.ts` 的 `callingCodePromptQueries`）。表里只放把握十足的；查不到就退回居住国，不猜。
 */
const CALLING_CODE_COUNTRY: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze(Object.fromEntries(
  ('20EG 27ZA 30GR 31NL 32BE 33FR 34ES 36HU 39IT 40RO 41CH 43AT 45DK 46SE 47NO 48PL 49DE 51PE 52MX 53CU 54AR 55BR 56CL ' +
   '57CO 58VE 60MY 62ID 63PH 64NZ 65SG 66TH 81JP 82KR 84VN 86CN 90TR 91IN 92PK 93AF 94LK 95MM 98IR 212MA 213DZ 216TN ' +
   '233GH 234NG 251ET 254KE 255TZ 256UG 351PT 352LU 353IE 354IS 356MT 357CY 358FI 359BG 370LT 371LV 372EE 373MD 374AM ' +
   '375BY 380UA 381RS 385HR 386SI 387BA 420CZ 421SK 852HK 853MO 855KH 856LA 880BD 886TW 960MV 961LB 962JO 963SY 964IQ ' +
   '965KW 966SA 967YE 968OM 970PS 971AE 972IL 973BH 974QA 975BT 976MN 977NP 992TJ 993TM 994AZ 995GE 996KG 998UZ')
    .split(' ').map((pair) => [pair.slice(0, -2), pair.slice(-2)]),
));

/** 区号只属于一个国家时的那个国家（`86` → `CN`）；几国共用或表里没有就 null。 */
export function callingCodeCountry(code: string): string | null {
  return CALLING_CODE_COUNTRY[code] ?? null;
}

/** 选项里多数（占位项与分隔线除外）都带着一个区号。 */
export function looksLikeCallingCodeOptions(options: readonly string[]): boolean {
  const real = options.map((text) => text.trim()).filter((text) => text !== '' && !/^-+$/u.test(text));
  if (real.length < 2) return false;
  const coded = real.filter((text) => callingCodeOfOption(text) !== null).length;
  return coded >= Math.max(2, Math.ceil(real.length * 0.8));
}

/**
 * 页面自己告诉用户「这一栏要从建议里选」（2026-09-28 Shopify 的 Location：「Start typing and select a location from the
 * dropdown.」，旁边还有一个存选中值的隐藏栏）。整串写进去宿主不收——看着填了，表单里没有值。没有 ARIA 下拉语义、
 * 也没有规则量过的绑定时，这一栏交还本人（WIDGET）。
 */
const PICK_FROM_SUGGESTIONS =
  /\b(?:start|begin)\s+typing\b[^.]{0,80}\b(?:select|choose|pick)\b|\b(?:select|choose|pick)\b[^.]{0,60}\bfrom\s+the\s+(?:drop-?\s?down|list|suggestions?|options)\b/u;

export function describesPickFromSuggestions(text: string): boolean {
  return PICK_FROM_SUGGESTIONS.test(normalizeGuardText(text));
}

/**
 * 学历、工作经历那一节的标题（2026-09-28 通用路）。规则按标签把「University」「Major」「Employed From Month」认成
 * 学历／经历的第一段；通用路没有行作用域，同名栏也可能在问别的（「Which university did you hear about us at?」
 * 不会，但「Degree」「Major」这种单词离开那一节就说不清）。所以 engine 只在这一栏落在说到学历／经历的那一节里
 * 时才认：`role=group` 的可读名、fieldset 的 legend、前面最近的标题，三者之一说到它。
 */
// 整词比（前后不是字母）：「Request information」里藏着一个 formation，不算学历。
const EDUCATION_CONTEXT =
  /(?<!\p{L})(?:education(?:al)?|academic|school(?:ing)?|universit(?:y|ies)|colleges?|studies|degrees?|ausbildung|studium|bildungsweg|hochschul\p{L}*|formation|[ée]tudes|educaci[óo]n|estudios|formaci[óo]n)(?!\p{L})/iu;
const EXPERIENCE_CONTEXT =
  /(?<!\p{L})(?:employment|experience|work\s+history|professional\s+history|career\s+history|employers?|previous\s+(?:jobs?|positions?|roles?)|berufserfahrung|werdegang|berufliche\p{L}*|exp[ée]rience|experiencia|historial\s+laboral)(?!\p{L})/iu;

/** 这一节的标题说到了这一类集合（`education.*` 看学历，`experience.*` 看经历）。 */
export function sectionMentionsCollection(caption: string, role: string): boolean {
  if (role.startsWith('education.')) return EDUCATION_CONTEXT.test(caption);
  if (role.startsWith('experience.')) return EXPERIENCE_CONTEXT.test(caption);
  return true;
}

/**
 * 一栏所在那一节的标题文字：最近的 `role=group` 的可读名、最近的 fieldset 的 legend、前面最近的一个标题，
 * 三者拼在一起（读不到的那一样就是空），给 `sectionMentionsCollection` 判。只读结构与文字。
 * `scope` 是找标题的范围（扫描根，或整页）。
 */
export function createSectionCaptioner(
  scope: { querySelectorAll(selector: string): Iterable<Element> | ArrayLike<Element> },
): (element: Element) => string {
  const headings = Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'));
  const text = (element: Element | null | undefined): string => (element?.textContent ?? '').replace(/\s+/gu, ' ').trim();
  return (element: Element): string => {
    const group = element.closest('[role="group"]');
    const labelledBy = group?.getAttribute('aria-labelledby')?.trim().split(/\s+/u) ?? [];
    const groupName = [
      group?.getAttribute('aria-label') ?? '',
      ...labelledBy.map((id) => text(group?.ownerDocument.getElementById(id))),
    ].join(' ');
    const legend = text(element.closest('fieldset')?.querySelector(':scope > legend'));
    let preceding: Element | null = null;
    for (const heading of headings) {
      // 4 = DOCUMENT_POSITION_FOLLOWING：这一栏在标题之后。
      if (heading.compareDocumentPosition(element) & 4) preceding = heading;
    }
    return [groupName, legend, text(preceding)].join(' ');
  };
}
