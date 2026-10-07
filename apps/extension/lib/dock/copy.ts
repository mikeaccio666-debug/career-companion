/**
 * 浮层说的每一句话（2026-09-23 设计交接 `handoff/03-文案对照.md`）。
 *
 * 只有文案、状态与说明，没有任何宿主表单上的值或资料里的值。
 *
 * 2026-09-25 起中英两套，按浏览器的界面语言挑（`browserDockLocale`）：中文界面说中文，其余一律说英文。英文那一套的
 * 措辞照商店宣传图里的英文浮层（`商店宣传图-ArgoLand.AI/build.py` 第 11 节：Autofill、Needs you、Continue to next page、
 * Filled on your behalf……），上架的产品与宣传图说同一种话。两套形状一样（`en` 按 `zh` 的类型写，少一句就编译不过）；
 * 按码查的几张表（reasons、outcomes……）类型挡不住漏写，由 `tests/dock-english.test.ts` 逐键比对。
 *
 * 两套都是普通的对象字面量、只在文件末尾冻结一次，并标成纯的：浮层挂不出来的构建（Assistant）里没人用它们，打包时
 * 整份删掉，不占 apply.js 的预算。
 */

import type { DockPortalPage } from './types';

export type DockLocale = 'zh' | 'en';

/** 界面语言 → 浮层用哪一套：zh、zh-CN、zh-TW、zh-Hant-HK……都说中文；其余（含读不到）一律说英文。 */
export function dockLocaleOf(language: string | null | undefined): DockLocale {
  return /^zh(?:[-_]|$)/iu.test((language ?? '').trim()) ? 'zh' : 'en';
}

/** 读界面语言要用的两样；测试注入一个假的。 */
export interface DockLanguageScope {
  readonly chrome?: { readonly i18n?: { readonly getUILanguage?: () => unknown } };
  readonly navigator?: { readonly language?: unknown };
}

/**
 * 这个浏览器的界面语言说哪一套：先问 `chrome.i18n.getUILanguage()`（Chrome 的显示语言），问不到再看
 * `navigator.language`。只读语言标签，不读页面上的任何东西。
 */
export function browserDockLocale(scope: DockLanguageScope = globalThis as unknown as DockLanguageScope): DockLocale {
  const ui = chromeUiLanguage(scope);
  const nav = scope.navigator?.language;
  return dockLocaleOf(ui ?? (typeof nav === 'string' ? nav : null));
}

function chromeUiLanguage(scope: DockLanguageScope): string | null {
  try {
    const language = scope.chrome?.i18n?.getUILanguage?.();
    return typeof language === 'string' && language.trim() !== '' ? language : null;
  } catch {
    // 插件刚被重载、这一页的扩展上下文已失效时 chrome.* 会抛：当作问不到，退回 navigator.language。
    return null;
  }
}

/** 国家码 → 浮层那一套语言里的国名（工作授权那几句用）；环境不支持就退回码本身。 */
export function dockRegionName(code: string, locale: DockLocale = 'zh'): string {
  try {
    return new Intl.DisplayNames([locale === 'en' ? 'en-US' : 'zh-CN'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 英文的数量：1 field、3 fields。 */
const plural = (value: number, one: string, many = `${one}s`): string => `${value} ${value === 1 ? one : many}`;
/** 英文的动词跟着数走：1 needs、3 need。 */
const needVerb = (value: number): string => (value === 1 ? 'needs' : 'need');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (month: number): string => MONTHS[month - 1] ?? String(month);

const zh = {
  product: 'Career Companion',
  launcher: '打开 Career Companion',
  /** 收起按钮的读屏名字：数字写进去，角标本身只给眼睛看。 */
  launcherWithNeeds: (count: number) => `打开 Career Companion，还有 ${count} 项需要你`,
  hideLauncher: '隐藏入口',
  hidden: '已隐藏，刷新页面可恢复。',
  collapse: '收起',
  account: '账户',
  back: '返回',
  profileTitle: '我的资料',
  more: '更多',

  launcherState: {
    preparing: '准备中',
    filling: (done: number, total: number) => `正在填写 ${done}/${total}`,
    /** 规则那几遍写完了、AI 代答还在起草（2026-09-24）：这一轮还没完。 */
    aiFilling: 'AI 正在填写',
    needs: (count: number) => `还有 ${count} 项需要你`,
    allDone: '都填好了',
    review: '到检查页了',
    ready: '自动填写',
    idle: 'Career Companion',
  },

  /** 调用方没说是哪一家（`vendorLabel`）时，岗位卡副标题与进度卡上写的那个名字。 */
  vendorFallback: '申请表',
  /** 读不出岗位名时岗位卡的标题；`ats` 是 null 就是不知道是哪一家。 */
  jobFallback: (ats: string | null) => `${ats ?? '申请表'} 申请表`,
  submittedTag: '已提交',

  /** 首页展开的岗位卡（2026-09-24）：办公方式与雇佣类型照设计写英文，与招聘网站上的说法一致。 */
  jobCard: {
    detail: '查看完整岗位详情',
    today: '今天',
    daysAgo: (days: number) => `${days} 天前`,
    monthsAgo: (months: number) => `${months} 个月前`,
    yearsAgo: (years: number) => `${years} 年前`,
    per: (currency: string, unit: 'YEAR' | 'MONTH' | 'WEEK' | 'DAY' | 'HOUR') =>
      `${currency} / ${({ YEAR: '年', MONTH: '月', WEEK: '周', DAY: '天', HOUR: '小时' } as const)[unit]}`,
    workMode: { REMOTE: 'Remote', HYBRID: 'Hybrid', ONSITE: 'On-site' },
    employment: { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACT: 'Contract', INTERNSHIP: 'Internship' },
    highlightsAria: '和你的匹配点',
  },

  autofill: '自动填写',
  submitted: '提交成功',

  faces: {
    unlinked: {
      title: '连接 Career Companion，一键填好申请表',
      sub: '用你在 Career Companion 保存的资料填写，提交前你都能检查一遍。',
      primary: '登录 Career Companion',
    },
    linking: {
      title: '等你在 Career Companion 登录',
      sub: '已在新标签页打开 Career Companion。登录后回到这里，会自动继续。',
      ghost: '取消',
    },
    dormant: {
      title: '这是职位详情页',
      sub: '打开申请表后，就能自动填写。',
      primary: '打开申请表',
    },
    noForm: {
      title: '这一页还看不到申请表',
      sub: '申请表出现后，就能自动填写。',
    },
    rules: {
      title: '暂时没法判断这一页能不能自动填写',
      sub: '过一会儿再试，你的资料不受影响。',
      secondary: '重新检查',
      checking: '正在检查…',
    },
    /** 认出了申请表，但这一家还没在运行时包里放行（2026-10-04）：不是连不上，也不是认不出。 */
    closed: {
      title: '这类网站还没开放自动填写',
      sub: 'Career Companion 还没为这类网站打开自动填写。你可以照常在网站上自己填写，你的资料不受影响。',
    },
    signin: {
      title: (ats: string | null) => `先在 ${ats ?? '申请表'} 登录`,
      sub: '账号和密码由你在网站上创建。登录后，这里会自动继续。',
      waiting: '等你登录',
    },
  },

  run: {
    filling: '正在填写',
    nextPage: '已到下一页，正在填写这一页…',
    /** 进度卡上那一行：此刻在做什么（2026-09-28）。 */
    readingForm: '正在读表单',
    matchingProfile: '正在对照你的资料',
    matchingOptions: '正在匹配选项',
    section: (kind: 'education' | 'experience', number: number, total: number) =>
      `正在填${kind === 'experience' ? '工作经历' : '教育经历'} ${number}/${total}`,
    waitingAi: '正在等 AI',
    writingLetter: '正在写求职信',
    confirmingShort: '正在确认网站收下了',
    writing: '正在填写…',
    confirming: '正在确认填写结果…',
    checked: '已勾选',
    stop: '停止',
    /** 收起那一行与读屏（`summaryText`）：还在准备、途中必填的计数。 */
    summaryPreparing: '正在准备…',
    /** 只写数，不编百分比（2026-09-28）。 */
    required: (done: number, total: number) => `必填 ${done}/${total}`,
    /** 联调包的运行只报阶段与计数（`dockRunSummary`）。 */
    scanning: (controls: number) => `正在读表单 · 已看到 ${controls} 栏`,
    composing: (observable: number, authorized: number) => `${observable} 个问题里，我们可以答 ${authorized} 个`,
    nothingRequired: '这个表单没有需要我们填的必填项',
  },

  summary: {
    review: { title: '到检查页了', sub: '这一页没有要填的。核对无误后，就可以提交了。' },
    stopped: { title: '填写已停止', sub: (filled: number) => `已填好 ${filled} 项，其余的请在网站上完成。` },
    needs: (count: number, page: boolean) => `${page ? '这一页还有 ' : '还有 '}${count} 项需要你`,
    allDone: { title: '必填项都填好了', sub: '检查一遍，没问题就可以提交了。' },
    pageDone: { title: '这一页填好了', sub: '继续后，会接着填下一页。' },
    /** 还有要他处理的时候总结下面那一句：只说填好了多少（2026-09-28：总结只说一件事）。 */
    filledSub: (filled: number, ai: number) => `已填好 ${filled} 项${ai > 0 ? `，AI 写了 ${ai} 项` : ''}`,
    nothing: { title: '这一页没有要你填的', sub: '检查一遍，没问题就可以提交了。' },
  },
  /** 两句接成一句（总结下面那一行：「已填好 N 项，其中 AI 代答 M 项」＋ 下一步）。 */
  sentences: (first: string, second: string) => `${first}。${second}`,

  /**
   * 连填（2026-09-28 负责人：按一下「自动填写」，一页一页填到检查页，停在那里等他按「提交」）。进度卡上说第几页、这一步
   * 叫什么（网站说得出才写，名字照网站的原文）；到头了一句话总结；半路停下只说他要做的那一件事。
   */
  chain: {
    /** 进度卡上那一行：第几页、共几页、这一步叫什么（后两样网站说得出才写）。 */
    status: (page: number, total: number | null, step: string | null) =>
      `第 ${page} 页${total === null ? '' : `，共 ${total} 页`}：${step === null ? '正在填写' : `正在填「${step}」`}`,
    /** 这一页填好了、正在替他翻到下一页时那一行。 */
    filled: (page: number, total: number | null) => `第 ${page} 页${total === null ? '' : `，共 ${total} 页`}：已填好`,
    advancing: '正在翻到下一页…',
    pressing: (label: string) => `正在按网站上的「${label}」`,
    /** 填到头了（检查页，或最终提交所在的那一页）。`onSite`：插件替他按不了提交，要他在网站上点。 */
    doneTitle: '都填好了',
    doneSub: (pages: number, fields: number, onSite: boolean) =>
      `已连着填好 ${pages} 页${fields > 0 ? `，共 ${fields} 项` : ''}。检查一遍，没问题就${onSite ? '在网站上点提交' : '按「提交」'}。`,
    /** 半路停下时总结下面那一行：前面几页已经填好了。 */
    sofar: (pages: number) => `前 ${pages} 页已经填好。`,
    /** 这一页还有要他处理的：处理好之后的那一步。 */
    needsNext: '处理好之后点「继续到下一页」，会接着往下填。',
    /** 这一页上弹出了只能本人处理的关卡（翻页之前、或按了下一步之后）。 */
    walls: {
      LOGIN: { title: '网站要你先登录', sub: '在网站上登录之后，点「继续到下一页」接着往下填。' },
      VERIFICATION: { title: '网站要你输入验证码', sub: '在网站上输入验证码之后，点「继续到下一页」接着往下填。' },
      CAPTCHA: { title: '网站要你先完成人机验证', sub: '在网站上完成验证之后，点「继续到下一页」接着往下填。' },
    },
    /** 到上限了：总结下面那一行（标题照旧是「这一页填好了」）。 */
    pageCap: (pages: number) => `已经连着填了 ${pages} 页，先停在这里。检查一遍，再点「继续到下一页」接着填。`,
    timeCap: '这一轮已经连着填了好几分钟，先停在这里。检查一遍，再点「继续到下一页」接着填。',
    /** 翻页按钮说不清是哪一颗（不止一颗、或读不出页面）：不替他猜，也不说「都填好了」。 */
    unavailable: '这一页填好了，但网站上的「下一步」这次说不清是哪一颗。请在网站上自己点，到了下一页再点「自动填写」接着填。',
    /** 网站此刻在这一页上标着错（2026-10-04）：`aria-invalid`、表里显示着的报错提示。不替他按「下一步」。 */
    siteErrors: { title: '网站在这一页上标出了问题', sub: '看一下网站上的红色提示，改好之后点「继续到下一页」，会接着往下填。' },
    /** 翻过去之后那一页上没有我们能填的表：失败卡的标题与副标题（卡上的按钮是「再试一次」）。 */
    blocked: {
      LOGIN: { title: '网站要你先登录', sub: '在网站上登录之后，点「再试一次」接着往下填。' },
      VERIFICATION: { title: '网站要你输入验证码', sub: '在网站上输入验证码之后，点「再试一次」接着往下填。' },
      CAPTCHA: { title: '网站要你先完成人机验证', sub: '在网站上完成验证之后，点「再试一次」接着往下填。' },
      UNKNOWN_PAGE: { title: '这一页要你自己填', sub: '这一页我们认不出要填的。在网站上填好、翻到下一页之后，点「再试一次」接着往下填。' },
      UNAVAILABLE: { title: '这一页暂时说不清', sub: '读不出这一页上有没有要你本人处理的。在网站上看一眼，处理好之后点「再试一次」。' },
    } as Record<string, { title: string; sub: string }>,
  },

  /**
   * 没能开始、而原因是一件他要先做（或我们还没开放）的事（2026-10-04）：失败卡换成这一句标题与说明，不说「这一轮没有完成」，
   * 更不说「连不上」。卡上照旧有「再试一次」——他做完那一件事，按它接着填。
   */
  blockedFaces: {
    VENDOR_CLOSED: { title: '这类网站还没开放自动填写', sub: 'Career Companion 还没为这类网站打开自动填写。你可以照常在网站上自己填写，你的资料不受影响。' },
    CONSENT_GATE: { title: '先过网站的数据同意这一步', sub: '在页面上选好你的居住地，看完条款后点同意，申请表就会出来。然后点「再试一次」。' },
    // 替他选好了居住地（D7），网站把那一份条款摆了出来、要人点同意：那一下由他本人点。
    CONSENT_GATE_ACCEPT: { title: '已替你选好居住地，条款请你看完点同意', sub: '网站把这一份条款摆在页面上了：看完之后点同意（例如「Accept」），申请表就会出来。然后点「再试一次」。' },
    APPLY_FORM_NOT_OPENED: { title: '申请表还没打开', sub: '先点页面上的申请按钮（例如「Apply for This Job」），表单出现后点「再试一次」。' },
  } as Record<string, { title: string; sub: string }>,

  failed: {
    network: { title: '暂时连不上 Career Companion', sub: '没能开始填写，稍后再试一次。' },
    unknown: { title: '这一轮没有完成', sub: '再试一次；如果还不行，刷新页面后再试。' },
    retry: '再试一次',
    tech: '技术细节',
    copy: '复制',
    copied: '已复制，可以直接发给我们',
    copyFailed: '没能复制，请手动选中上面的代号复制。',
    openForm: '打开申请表',
  },

  /**
   * 插件更新（或重载、停用）之后，这一页和插件断了线（2026-10-03 体检 3e）：哪一颗要找插件的按钮都不会有回音。照实说，
   * 给一颗「刷新页面」。有的网站刷新后会清空已填的内容，说一句，让他自己掂量。
   */
  updated: {
    title: 'Career Companion 已更新',
    sub: '刷新这一页即可继续。有的网站刷新后会清空已填的内容。',
    reload: '刷新页面',
  },

  banner: {
    stuck: {
      title: '网站没有翻页',
      text: (count: number) => `这一页还有 ${count} 项必填没填好。看一下网站上的红色提示，改好再继续。`,
      filled: '先看网站上的提示：某一栏标红，就改好再继续；页面报错（比如 Error Code），多半是网站会话过期了，刷新页面后再试。',
    },
    fixed: { title: '都改好了', text: '再点一次「继续到下一页」。' },
    notSubmitted: {
      title: '网站没有提交',
      text: '看一下网站上的红色提示，改好后再点一次「提交」。',
    },
    unconfirmed: {
      title: '还没看到网站的确认',
      text: '在网站上看一眼是否已经提交成功，再决定要不要重新提交。',
    },
  },

  lists: {
    signed: '已按你的授权代填',
    signedNote: '按你在资料页的授权与回答代填，提交前请核对。',
    rest: '其余已填好',
    optional: '选填',
    yourData: '你的资料',
    locateAria: (question: string) => `${question}，在网页上找到这一题`,
    youFilled: '你已填好',
    alreadyThere: '网页上已经有了，没有改动',
    fromResume: '网站从你的简历里读的',
    /** 一栏好几项（一行一项）在「其余已填好」里连起来。 */
    valueJoin: '、',
  },

  /**
   * 「需要你」按要做的事分组、在浮层里就能办完（2026-09-28）：组名、每一行的动作、每一行下面那一句（照着做就好）。
   */
  needs: {
    groups: { choose: '选一个', write: '写一段', missing: '资料里没有', decide: '你来决定', check: '去网页上看一眼', review: '提交前核对' },
    more: '更多选项',
    go: '去这一栏',
    goPick: '去这一栏选',
    goWrite: '去这一栏写',
    fill: '填入',
    filling: '正在填入…',
    placeholder: '填在这里',
    choosePlaceholder: '选一个…',
    aiWrite: 'AI 帮我写',
    aiWriting: 'AI 正在写…',
    aiFill: '填入 AI 写的',
    chipAria: (option: string) => `选「${option}」`,
    inputAria: (question: string) => `「${question}」的答案`,
    why: {
      noMatch: (hint: string | null) => (hint === null ? '选项里没有和你资料一样的，挑最接近的一个' : `选项里没有「${hint}」，挑最接近的一个`),
      ambiguous: (hint: string | null) => (hint === null ? '有几个选项都可能对，挑一个' : `有几个选项都像「${hint}」，挑一个`),
      incomplete: '选项没能读全，挑一个，或去这一栏看全部',
      notLoaded: '网站的选项没加载出来，去这一栏选',
      suggested: '按岗位地点推断的，点一下确认',
      jobDependent: '这一题看岗位，挑一个',
      missing: '你的资料里还没有这一项',
      missingChoice: '你的资料里没有这一题的答案，挑一个',
      unknown: '我们没认出这一题，你来答一下',
      openQuestion: '开放题，用你自己的话写几句',
      aiNothing: 'AI 在你的资料里没找到依据，自己写几句',
      aiMissed: 'AI 这次没答上，再试一次',
      aiUsedUp: '这个月的 AI 次数用完了，自己写几句',
      eeoUnavailable: '暂时读不到你保存的答案，在这一栏选一下就好',
      employer: '答一次，记进你的资料，以后自动答',
    },
    /** 「可以联系你现在的雇主吗」（2026-09-28）：浮层里的两颗，点了之后那一句。 */
    employer: {
      yes: '可以',
      no: '不可以',
      saved: '已记进你的资料，以后自动答',
      notSaved: '已填上。这次没能记进资料，下次还会问你',
    },
    /** 在浮层里答上的那一格，写在「其余已填好」里值的后面。 */
    answered: '你填的',
    answerFailed: {
      UNTRUSTED: '没接到这一下，请再点一次',
      ENDED: '这一轮已经结束了，在网页上填这一项吧',
      CHANGED: '这一栏刚有了内容，没有覆盖',
      REFUSED: '没能填进去，在网页上填这一项吧',
    },
  },

  /** 进度卡底下那一行实时的数（2026-09-28）：已填 · AI 写的 · 需要你 · 按规定不代填。 */
  tally: {
    filled: (count: number) => `已填 ${count}`,
    ai: (count: number) => `AI 写的 ${count}`,
    needs: (count: number) => `需要你 ${count}`,
    kept: (count: number) => `按规定不代填 ${count}`,
  },

  /**
   * AI 代答（2026-09-23）与「用 AI 写 / AI 改写」（2026-09-24）。次数用完只说一句，不推销、不倒计时；
   * 卡片里的「升级会员」只是一个去门户套餐页的链接。
   */
  /** 求职信（2026-09-27）：表上有求职信栏就为这个岗位写一封附上。 */
  letter: {
    writing: '正在为这个岗位写求职信…',
    readyRow: '求职信写好了，点上面的「附上求职信」',
    readyTitle: '求职信写好了',
    readyText: '为这个岗位写的。附上之后可以在网页上看，提交前随时能改。',
    attach: '附上求职信',
    attaching: '正在附上…',
    attached: '已附上为这个岗位写的求职信',
    attachFailed: '没能附上，求职信那一栏要你自己附',
    refused: {
      NEEDS_PAGE_JOB: '读不到这个岗位的描述，求职信要你自己附',
      JOB_TEXT_UNUSABLE: '这一页的岗位描述没法用来写信，求职信要你自己附',
      PROFILE_UNAVAILABLE: '你的资料还不够写一封求职信，先去 Career Companion 补全经历',
      AUTH_REQUIRED: '登录已过期，重新登录 Career Companion 后再写求职信',
      PAYWALL_REQUIRED: '写求职信要开通会员，这一栏先由你自己附',
      USAGE_EXHAUSTED: '这个月写求职信的次数用完了，这一栏要你自己附',
      TARGET_NOT_ALLOWED: '这个网站还不能接收求职信，要你自己附',
      UNAVAILABLE: '求职信这次没写出来，要你自己附',
    },
  },
  // 答案记忆（2026-09-28 起默认开）：账户菜单里的开关，与第一次记住时说的那一句。
  memory: {
    switchLabel: '记住我的回答',
    switchOn: '已打开：你在这里答的，下次自动填',
    switchOff: '已关闭：不再记住你在这里答的',
    switchFailed: '没能保存这个开关，请稍后再试。',
    noted: '已记住，下次自动填 · 可在菜单里关',
  },
  ai: {
    group: 'AI 代答',
    groupNote: '按你保存的资料起草，提交前请核对；不想用可以在账户菜单里关掉。',
    /**
     * 进度卡上那一行（2026-09-24 负责人：AI 在写，进度框就该还在、写明 AI 在填）。题数还没交来就不写数。
     */
    drafting: (count: number) => (count > 0 ? `AI 正在按你的资料填写 ${count} 道题…` : 'AI 正在按你的资料填写…'),
    /** 送给了 AI、AI 在资料里没找到依据的题（2026-09-24 测试台：从前仍说「我们没认出这道题」）。 */
    noEvidence: 'AI 在你的资料里没找到依据',
    /** 送给了 AI、这一轮却没拿到答案的题（那一道失败了、流断了；2026-09-24）。 */
    unanswered: 'AI 这次没答上这一题',
    applied: (count: number) => `AI 已代答 ${count} 项，提交前请核对`,
    readyTitle: (count: number) => `AI 起草好了 ${count} 道题的答案`,
    readyText: '按你保存的资料起草。点一下填进网页，提交前请核对。',
    readyButton: '填入 AI 答案',
    applying: '正在填入…',
    applyFailed: '没能填入 AI 答案，这几题请你自己答。',
    filled: (filled: number, ai: number) => `已填好 ${filled} 项${ai > 0 ? `，其中 AI 代答 ${ai} 项` : ''}`,
    /** AI 代答那一组里每一行下面的「换一个说法」（2026-09-28）。 */
    rephrase: '换一个说法',
    rephrasing: '正在换…',
    rephraseFill: '填入新的说法',
    rephrased: '换好了，提交前请核对',
    switchLabel: 'AI 代答',
    switchOn: '已打开 AI 代答',
    switchOff: '已关闭 AI 代答',
    switchFailed: '没能保存 AI 代答的开关，请稍后再试。',
    chip: {
      write: '用 AI 写',
      revise: 'AI 改写',
      writeAria: '用 AI 写这一题',
      reviseAria: '用 AI 改写这一题',
    },
    card: {
      writeTitle: '用 AI 写这一题',
      reviseTitle: 'AI 改写这一题',
      placeholder: '告诉我你想补充、修改或改进什么',
      cancel: '取消',
      generate: '生成',
      generating: '生成中…',
      fill: '填入',
      remaining: (count: number) => `本月还可以用 ${count} 次`,
      usedUp: '本月的 AI 次数用完了',
      usedUpUntil: (month: number, day: number) => `本月的 AI 次数用完了，${month} 月 ${day} 日恢复`,
      upgrade: '升级会员',
      unavailable: '暂时用不了，稍后再试',
      login: '登录已过期，重新登录 Career Companion 后再试',
      changed: '这一栏刚被改过，没有覆盖',
      pageChanged: '页面刚刚变化了，请再试一次',
      untrusted: '没接到你这一下，请再点一次',
      tooLong: '这一栏的内容太长，AI 改写不了',
      switchedOff: 'AI 代答已关闭，可以在账户菜单里打开',
      expired: '写好了，点「填入」把它写进这一栏',
      written: '已写进这一栏，提交前请核对',
    },
  },

  /**
   * 网站把验证码发到他的邮箱、要他填进这一页（2026-10-04，负责人：验证码第 1 步）。卡上照实说发生了什么、去哪个收件箱
   * 找哪一封；验证码由他自己在卡上那一格里输或粘贴，按「填进网站」才写进网站。插件不读邮件，也不因为填了验证码就提交。
   */
  emailCode: {
    title: '网站给你的邮箱发了一个验证码',
    /** `inbox`：网站说发到了哪个邮箱，读不出是 null；`from`：发件地址（不止一个时只写第一个，后面说「一类地址」）。 */
    ask: (site: string, inbox: string | null, from: string, more: boolean, subject: string | null, length: number) =>
      `${site}要确认这份申请是你本人投的：去${inbox === null ? '你申请时填的邮箱' : ` ${inbox} `}的收件箱，找一封来自 ${from}${more ? ' 一类地址' : ''}的邮件${subject === null ? '' : `（标题以「${subject}」开头）`}，把里面的 ${length} 位验证码粘贴到下面。没看到就看一眼垃圾邮件。`,
    placeholder: (length: number, digits: boolean) => `${length} 位${digits ? '数字' : '验证码'}`,
    enter: '填进网站',
    entering: '正在填…',
    privacy: '我们不读你的邮件：验证码只由你输入，只填进这一页。',
    /** 网站说验证码怎么了。 */
    errors: {
      WRONG: { title: '验证码不对', sub: '网站说这个验证码不对。对照邮件再输一次（留意大小写，以及 0 和 O、1 和 l 这类相近的字符）。' },
      EXPIRED: { title: '验证码过期了', sub: '网站说这个验证码已经过期。看一下邮箱里有没有更新的一封，把新的验证码输在下面；没有的话照网站上那一行字做。' },
      TOO_MANY: { title: '试的次数太多了', sub: '网站说试的次数太多了。先照网站上那一行字做，过一会儿再试。' },
      OTHER: { title: '网站没收下这个验证码', sub: '对照邮件再输一次，或者照网站上那一行字做。' },
    } as Record<'WRONG' | 'EXPIRED' | 'TOO_MANY' | 'OTHER', { title: string; sub: string }>,
    /** 网站自己的那一句原话（只在本机浮层上显示）。 */
    siteSays: (text: string) => `网站的原话：「${text}」`,
    filled: {
      title: '验证码已填进网站',
      resubmitHere: '现在按下面的「提交」，再交一次。',
      resubmitOnSite: '现在去网站上再按一次提交。',
      verify: '现在去网站上按验证（Verify）那一颗。',
    },
    /** 按「填进网站」之后没写上：卡上那一行。 */
    notes: {
      FORMAT: (length: number, digits: boolean) => `验证码应该是 ${length} 位${digits ? '数字' : '字母或数字'}，检查一下再填。`,
      GONE: '网站上的验证码栏已经不在了。',
      OFF: '这一次没法替你填，请直接在网站上输入验证码。',
      UNTRUSTED: '这一下没能确认是你本人点的，请再点一次。',
      FAILED: '没能填进网站，请直接在网站上输入验证码。',
    },
  },

  /**
   * 招聘网站账号（2026-09-28，负责人：替用户在 Workday／iCIMS 上注册、登录）。每一件替他做的事都照实说；
   * 同意的来源只说「资料页的代填授权」、详见隐私政策，不在这里复述条款。
   */
  siteAccount: {
    vaultList: {
      loading: '正在读取保存的网站…', empty: '还没有关联到网站的账号。', unavailable: '暂时读不到保存的网站，请稍后再试。',
      keyMissing: '本机密钥丢失，保存的密码无法恢复，请到网站上重设。', unreadable: '保存内容读不出来，请到网站上重设密码。',
      pending: '注册还没完成', registered: '已注册', saved: '已保存密码', needsPassword: '需要你保存密码',
      manage: '打开插件设置 / 导出', view: '在插件设置里查看', note: '换电脑或清除浏览器数据前先导出。密码只在插件自己的设置页查看。',
    },
    /** 浮层上怎么称呼这一家：「NVIDIA 的 Workday」；公司名读不出就只说厂商。 */
    site: (company: string, vendor: string) => (company === '' ? vendor : `${company} 的 ${vendor}`),
    register: '注册并自动填写',
    signIn: '登录并自动填写',
    /** 主卡下面那一行：这一家要先有账号。 */
    wallNote: (site: string) => `${site}要先有账号：我们用你的邮箱替你注册或登录，然后接着填。`,
    status: {
      PREPARING: (site: string) => `正在准备登录${site}…`,
      CHOOSING: (_site: string) => '正在选「用邮箱登录」…',
      REGISTERING: (site: string) => `正在替你在${site}注册账号…`,
      SIGNING_IN: (site: string) => `正在替你登录${site}…`,
      IDENTIFYING: (site: string) => `正在用你的邮箱登录${site}…`,
    },
    done: {
      REGISTERED: (site: string, email: string) => `已替你在${site}注册账号（${email}）`,
      generated: '已为这家网站生成独立密码，只存在这台电脑上；插件设置「招聘网站账号」里能看',
      SIGNED_IN: (site: string, email: string) => `已替你登录${site}（${email}）`,
      ACCOUNT_EXISTS: (site: string) => `${site}已经有你的账号，请输入这个网站的密码继续`,
      TERMS_ACCEPTED: (site: string) => `已替你同意${site}注册所需的网站条款`,
    },
    continuing: '已登录，正在填写申请表…',
    prompts: {
      SITE_PASSWORD: {
        title: (site: string) => `${site}的密码和我们保存的不一样`,
        sub: (email: string) => `这个网站已经有 ${email} 的账号。把这个网站的密码填在下面（只存在这台电脑上），我们替你登录。`,
        retrySub: '这个密码也不对。再输一次，或者去网站上重设。',
        placeholder: '这个网站的密码',
        primary: '用这个密码登录',
        forgot: '忘了密码？在网站上点「Forgot your password?」，按邮件里的链接重设，再把新密码填在这里。',
      },
      VERIFY_EMAIL: {
        title: '去邮箱点一下验证链接',
        /** `from`：规则里写的发件地址（2026-10-04）；没写就不提。 */
        sub: (site: string, email: string, from: string | null) =>
          `${site}给 ${email} 发了一封验证邮件${from === null ? '' : `（发件地址一般是 ${from}）`}。点一下里面的链接，再回到这一页。若仍需登录，我们会请你输入这个网站的密码。没看到就看一眼垃圾邮件。`,
        primary: '我已验证，继续',
      },
      CONSENT: {
        title: '先开启代填授权',
        sub: '替你注册、登录招聘网站，要先在「我的资料」里勾选代填授权（详见隐私政策）。也可以在网站上自己登录，再点「自动填写」。',
        primary: '打开我的资料',
      },
      OFF: {
        title: (site: string) => `先在${site}登录`,
        sub: '这个版本暂时不能替你注册、登录。在网站上登录（或注册）之后，点「自动填写」接着填。',
      },
      NO_EMAIL: {
        title: '暂时无法确认登录邮箱',
        sub: '新注册请先核对资料里的邮箱；已有网站账号可以先在网站上手动登录，再点「自动填写」。',
        primary: '打开我的资料',
      },
      UNAVAILABLE: { title: '暂时没法替你登录', sub: '稍后再试；或者在网站上自己登录之后，点「自动填写」接着填。' },
      CAPTCHA: { title: '网站要你先完成人机验证', sub: '在网站上完成验证，我们接着往下填。' },
      VERIFICATION: { title: '网站要你输入验证码', sub: '在网站上输入验证码，我们接着往下填。' },
      BLOCKED: { title: (site: string) => `${site}的账号现在登不了`, sub: '账号被锁，或者只能用单点登录（SSO）。在网站上处理好之后，点「再试一次」。' },
      REJECTED: { title: '网站没有接受', sub: '看一下网站上的红色提示，改好后点「再试一次」。' },
      NO_RESPONSE: { title: '还没看到网站的回应', sub: '在网站上看一眼；处理好之后点「再试一次」。' },
      TERMS_NEED_USER: { title: '注册条款要你自己勾', sub: '那一格里掺了注册之外的授权（比如订阅营销信息）。在网站上看一眼，勾好后点「再试一次」。' },
      EXPIRED: { title: '这一轮已经过期了', sub: '点「再试一次」，我们接着替你登录。' },
      FAILED: { title: '没能替你登录', sub: '网站的样子和我们认得的不一样了。在网站上自己登录之后，点「自动填写」接着填。' },
      CONTINUE_BY_HAND: { title: '已登录', sub: '点「自动填写」接着填这一页。' },
    },
    retry: '再试一次',
    /** 人机验证、验证码那张卡上：这一轮还在等他。 */
    waiting: '等你在网站上完成',
    menu: { item: '招聘网站账号' },
  },

  /**
   * 以你的名义代填的那一格，逐条说清是哪一类（2026-09-24 起多了六类同意；2026-09-28 起再加第五刀的新类别，
   * 以及按资料里的回答答的「能不能联系雇主」——那几句写明是按他的回答答的）。
   */
  signed: {
    TERMS_CONSENT: '已替你同意条款',
    TRUTH_ATTESTATION: '已替你声明所填属实',
    SIGNATURE_NAME: '已替你在签名栏填写姓名',
    SIGNATURE_DATE: '已替你填写签署日期',
    AI_RECORDING_CONSENT: '已替你同意：AI 面试记录',
    SMS_CONSENT: '已替你同意：短信通知',
    FUTURE_CONTACT_CONSENT: '已替你同意：日后联系',
    MARKETING_CONSENT: '已替你同意：营销信息',
    BACKGROUND_CHECK_CONSENT: '已替你同意：背景调查授权',
    ARBITRATION_AGREEMENT: '已替你同意：仲裁协议',
    RECRUITING_DATA_SHARING: '已替你同意：招聘服务商与关联公司处理你的申请资料',
    INFORMATION_VERIFICATION: '已替你同意：核实你所填的信息',
    SCREENING_CONSENT: '已替你同意：背景调查（信用、药检、驾驶记录等）',
    AT_WILL_ACKNOWLEDGEMENT: '已替你确认：at-will（随意雇佣）说明',
    ARBITRATION_WAIVER: '已替你同意：仲裁协议（含集体诉讼与陪审团弃权）',
    AI_INTERVIEW_ANALYSIS: '已替你同意：AI 分析面试录音',
    CALL_NOTIFICATION_CONSENT: '已替你同意：电话与 WhatsApp 通知',
    GROUP_FUTURE_CONTACT: '已替你同意：集团公司日后联系',
    PRIVACY_NOTICE_TITLE: '已替你确认：隐私声明',
    COMBINED_CONSENT: '已替你同意：一格里的几项，都在你授权的范围内',
    EMPLOYER_CONTACT_YES: '已替你答：可以联系你现在的雇主（按你的资料）',
    EMPLOYER_CONTACT_NO: '已替你答：不要联系你现在的雇主（按你的资料）',
    REFERENCE_CONTACT_YES: '已替你答：可以联系（与你对现在雇主的回答相同）',
    REFERENCE_CONTACT_NO: '已替你答：不要联系（与你对现在雇主的回答相同）',
  },

  /**
   * 代填授权的一键同意（2026-09-28）：没同意当前版本、也没撤回过的人（同意过旧版本的也在内：只有当前版本算数），浮层里
   * 一张卡请他同意。卡上照登那一句（与资料页那一格逐字相同），「隐私政策」点开就是写明范围的那一节；同意才记到
   * argoland，暂不就什么都不改。
   */
  reconsent: {
    title: '允许 Career Companion 替你处理条款和授权吗？',
    lead: '同意后，插件会以你的名义处理申请表上的条款、声明和授权，每一项都会在这里逐条列出；不同意也可以照常用，这些题交给你自己答。以前同意过旧版本的，需要再同意一次。',
    agree: '同意',
    agreeing: '正在保存…',
    later: '暂不',
    saved: '已开启代填授权',
    failed: '没能保存，请稍后再试',
  },

  /**
   * 按学历／工作经历推出来的答案（2026-09-24）：「其余已填好」里写在值后面，照实说是怎么来的。
   */
  historyBasis: {
    ADULT_FROM_HISTORY: '按你的学历／工作经历推断',
    EMPLOYER_IN_HISTORY: '你的工作经历里有这家公司',
    EMPLOYER_NOT_IN_HISTORY: '你的工作经历里没有这家公司',
    // 问的是「现在是否在职」，经历里有这家但已经结束：答「否」时不能说「没有这家公司」。
    EMPLOYER_ENDED: '你在这家公司的那段经历已结束',
    // 「Are you a transitioning service member?」「你服过兵役吗」答「否」（2026-09-24；后一问 2026-10-04）：工作经历里没有一段像军队服役。
    NO_MILITARY_SERVICE_IN_HISTORY: '你的工作经历里没有军队服役经历',
    // 2026-10-04 起按资料推出来的几类：说清楚是按资料里的哪一块答的，他看一眼就知道要不要改资料。
    STUDENT_FROM_EDUCATION: '按你的教育经历（在读与毕业时间）推断',
    EXPERIENCE_YEARS_FROM_HISTORY: '按你工作经历的起止时间算的',
    WORK_MODES_IN_PROFILE: '按你资料里可接受的办公方式答的',
    LANGUAGES_IN_PROFILE: '按你资料里的语言与水平答的',
    TRAVEL_IN_PROFILE: '按你资料里能接受的出差比例答的',
  },

  entries: {
    AUTOFILL_INFORMATION: { title: '我的资料', sub: '姓名、联系方式与地址' },
    RESUME: { title: '我的简历', sub: '在 Career Companion 里管理简历版本' },
    // 2026-09-27 起填写时自动写、自动附（表上有求职信栏就附）。
    COVER_LETTER: { title: '求职信', sub: '自动填写时为这个岗位写一封并附上' },
  },
  /** 「我的简历」那一行的副标题：默认简历的文件名。 */
  resumeDefault: (fileName: string) => `${fileName} · 默认`,

  bar: {
    presses: (label: string) => `会替你按网站上的「${label}」`,
    /** 还有要他处理的：主按钮带他去第一项，之后是「下一处」（2026-09-28）。 */
    first: '去第一项',
    nextItem: '下一处',
    next: '继续到下一页',
    /** 与「逐项处理」挤在一行时的那一颗（英文一行放不下全称）。 */
    nextShort: '继续到下一页',
    advancing: '正在翻页…',
    submit: '提交',
    submitOnSite: '去网站上提交',
  },

  menu: {
    openPortal: '打开 Career Companion',
    signOut: '退出登录',
    /** 账户菜单里的「语言」（2026-09-27）：选项本身各用自己的语言写（中文 / English）。 */
    language: '语言',
    rerun: '重新填写这一页',
    editProfile: '修改我的资料',
    /** 回到首页，网页上已经填好的都留着（不撤销）；再按「自动填写」就是新的一轮。 */
    home: '回到主页',
    undo: '撤销这次填写',
  },

  toast: {
    nextPage: '已到下一页，正在填写',
    advanced: '已到下一页。点「自动填写」填这一页。',
    pageChanged: '页面已换到下一步。点「自动填写」填这一页。',
    undone: '已撤销，这一页恢复到填写前',
    connected: '已连接 Career Companion',
    advanceUnavailable: '网站上的「下一步」此刻按不了，请在网站上自己点。',
    untrusted: '没接到你这一下，请再点一次。',
    submitOnSite: '检查一遍，然后在网站上点提交。',
    submitUnavailable: '网站上的「提交」此刻按不了，请在网站上自己点。',
    // 内容脚本打在浮层上的几句（退出登录、打开门户）。
    signedOut: '已退出登录。',
    signOutFailed: '暂时无法退出登录，请稍后再试。',
    portalOpened: 'Career Companion 已在新标签页打开。',
    portalFailed: '暂时无法打开求职助手，请打开本产品网页重试。',
    // 「打开申请表」没打开（2026-10-04）：从前一声不吭。
    openFormFailed: '暂时打不开申请表，请在网页上点申请按钮。',
  },

  /**
   * 一栏为什么没填上：只说「为什么」。表里没有的码什么都不补，码本身不给用户看。
   */
  /** 页面上还空着、读不出题目的那一道必填（lib/pageGaps.ts，2026-10-04）：浮层那一行的标题。 */
  unnamedRequired: '一道必填题（没读出题目）',
  /** 替他过数据同意页（2026-10-04，负责人 D7）：选上居住地、等网站打开申请表时，与新一页上照实说的那一句。 */
  consentGate: {
    choosing: '已按你资料里的居住地，替你在网站的数据同意页选了一项，正在等网站打开申请表…',
    passed: '已替你过了网站的数据同意页：按你资料里的居住地选了一项，网站随即打开了申请表。',
  },

  reasons: {
    // 2026-09-28 过了一遍：说人话、说他能照着做的，不说我们内部的说法（校验、授权范围、日志……）。
    LATE_REVERTED: '网站后来改掉了这一项，看一眼对不对',
    PLAN_STALE: '页面刚刚变了，请在网页上填这一项',
    NO_VALUE: '你的资料里还没有这一项',
    MISSING_PROFILE: '你的资料里还没有这一项',
    MANUAL_ONLY: '这一项只由你本人来答',
    OTHER_PERSON: '问的是别人的信息，由你来填',
    JOB_DEPENDENT: '答案取决于这个岗位',
    HOST_UNCONFIRMED: '填了，网站没有确认，看一眼对不对',
    CHOICE_NO_DATA: '你的资料里没有这一题的答案',
    NO_OPTION_MATCH: '选项里没有和你资料一样的',
    AMBIGUOUS_OPTION: '有几个选项都可能对',
    UNSUPPORTED_CONTROL: '这种栏目我们还填不了，请在网页上填',
    LOW_CONFIDENCE: '我们没认出这道题',
    USER_ONLY: '开放题，要用你自己的话回答',
    HOST_REJECTED: '网站说格式不对，照网页上的提示改一下',
    ABORTED: '填写停在了这一项之前',
    POLICY_DISABLED: '这个版本的插件暂时填不了这一项',
    DETACHED: '页面刚刚变了，请在网页上填这一项',
    CAPABILITY_DISABLED: '这一类暂时由你来填',
    PREFILLED_NEEDS_CONFIRMATION: '请确认这一项',
    CLICK_DENIED: '这类选项要你自己点',
    WIDGET_TIMEOUT: '网站的选项没加载出来',
    IDENTITY_CHANGED: '页面刚刚变了，请在网页上填这一项',
    TARGET_NOT_WRITABLE: '这一栏此刻填不进去，请在网页上看一眼',
    VALUE_COERCED: '网站改了格式，看一眼对不对',
    NOT_FOUND: '页面上找不到这一栏了',
    CONSENT_OFF: '你没开「代填同意」，这一项请自己勾',
    // 2026-09-23 补齐：这些码都能落到某一行上，从前原因那一行是空的。
    VERIFY_TIMEOUT: '填了，网站没来得及确认，看一眼对不对',
    WRITE_REVERTED: '填进去又被网站清掉了，请在网页上填',
    NOT_EMPTY: '网页上已经有内容，没有改动',
    OPTIONS_INCOMPLETE: '这一题的选项没能读全',
    DUPLICATE_FIELD: '这一题和另一栏重复，填在了那一栏',
    HOST_SUBMITTED: '填写途中网站开始提交了，看一眼网页',
    GESTURE_UNTRUSTED: '没接到你那一下点击，请再点一次自动填写',
    GESTURE_FOREIGN: '没接到你那一下点击，请再点一次自动填写',
    GESTURE_EXPIRED: '这一轮填写已经结束了，再点一次自动填写',
    GRANT_CONSUMED: '这一轮已经填过了，再点一次自动填写',
    LEASE_INVALID: '这一项这次没有替你填，请在网页上填',
    LEASE_EXPIRED: '这次申请已经过期了，请回到 Career Companion 重新开始',
    JOURNAL_UNAVAILABLE: '这一栏这次没有动（没法保证能撤销），请在网页上填',
    // 2026-10-04：页面上还空着、浮层没认出的必填（lib/pageGaps.ts）。只在浮层里用，不是内核的错误码。
    STILL_EMPTY: '这一题还空着，请在网页上填',
  } as Record<string, string>,

  /**
   * 工作授权题说得出是哪一国、他在那一国没有工作许可记录（2026-09-24）。
   *
   * 他有别国的记录：与竞品一样按默认答（负责人 2026-09-24 的决定：「就答是的」）——有权工作「是」、要不要担保
   * 「不需要」。「其余已填好」里在值后面写明是哪一国没有记录、默认答了什么，请他提交前核对（`defaulted`）。
   * 他一条记录都没有（或默认答案在页面上落不下）：照旧不答，不说「取决于这个岗位」（岗位国家已经知道了），照实说缺的
   * 是哪一国的记录（`noRecord`）。
   */
  workAuth: {
    noRecord: (region: string) => `你的资料里没有在${region}工作的许可记录`,
    defaulted: (region: string, sponsorship: boolean) =>
      `你的资料里没有在${region}工作的许可记录，默认答了「${sponsorship ? '不需要担保' : '是'}」，提交前请核对`,
  },

  /**
   * 每一段要单独保存的经历／教育（2026-09-24，Workable 的「Update」）。负责人定了全加全存：我们逐段加、填、
   * 替他按保存。存上了的算我们填好的；没存上的照实说还差什么；因此没加上的几段单列一行。
   */
  unsavedEntry: {
    question: (collection: 'education' | 'experience', number: number) =>
      `${collection === 'experience' ? '工作经历' : '教育经历'}第 ${number} 段`,
    range: (collection: 'education' | 'experience', from: number, to: number) =>
      `${collection === 'experience' ? '工作经历' : '教育经历'}第 ${from === to ? from : `${from}–${to}`} 段`,
    /** 按了没点成（远程关了、票过期、宿主想在这一下里提交被我们拦下）：填好的都在编辑框里，要他自己按。 */
    reason: (saveLabel: string) => `已填进网站的编辑框，点「${saveLabel === '' ? '保存' : saveLabel}」才会留下`,
    /** 我们没按：必填空着、或填了没回读成；一格都没写成时说不出是哪几格。 */
    missing: (labels: readonly string[], saveLabel: string) =>
      `${labels.length === 0 ? '这一段没能填进编辑框' : `还差${labels.map((label) => `「${label}」`).join('')}`}，填好后点「${saveLabel === '' ? '保存' : saveLabel}」`,
    /** 按了，编辑框还开着：网站自己的校验没过。 */
    rejected: (saveLabel: string) => `网站没收下这一段：看一下编辑框里的提示，改好后点「${saveLabel === '' ? '保存' : saveLabel}」`,
    /** 存上了：写在填进去的内容后面。 */
    saved: (saveLabel: string) => `已替你按「${saveLabel === '' ? '保存' : saveLabel}」保存`,
    notAdded: {
      afterUnsaved: '还没加进网站：先把前面那一段保存好，再点一次自动填写',
      editorOpen: '还没加进网站：这个区在网站上还开着一段没保存，处理好之后再点一次自动填写',
      again: '还没加进网站：再点一次自动填写，会接着加',
    },
  },

  /**
   * 一栏收好几项的搜索式多选（Workday 的技能，2026-09-24）没加上的几项：按原因分组列出来，原因与别处同一句话；
   * 这一页的搜索时间用完了（负责人：一页的答案 15 秒内）的那几项说「没来得及」。
   */
  notAdded: {
    late: '这一页的搜索时间用完了，没来得及',
    list: (groups: readonly Readonly<{ values: readonly string[]; why: string }>[]) =>
      `没加上：${groups.map((group) => `${group.values.join('、')}（${group.why}）`).join('；')}`,
    /** 总结下面那一行：哪一题、没加上的几项。 */
  },

  /** 没能开始时，认得的码换一句人话放在副标题里。 */
  outcomes: {
    NO_MISSION_FOR_PAGE: '这个岗位暂时不能自动填写。请刷新页面后再试。',
    RUNTIME_UNRESOLVED: '这一页暂时填不了。请稍后刷新页面再试。',
    RUN_FAILED: '填写中途出了问题，没有填完。请刷新页面后再试一次。',
    POLICY_DISABLED: '这个版本的插件暂时填不了这一页，稍后再试，或更新插件。',
    DETACHED: '页面刚刚变化了。请刷新页面后再点自动填写。',
    INTENT_REJECTED: '这次申请已经过期了。请回到 Career Companion 重新开始。',
    LOGIN_REQUIRED: '登录已过期。重新登录 Career Companion 后再试一次。',
    NOTHING_FILLED: '这一页没有我们能用你资料填的项目，其余问题请你本人完成。',
    NO_FORM_FOUND: '这一页暂时认不出申请表。请刷新后再试。',
    // 这一页有密码框、却不是规则声明过的账号墙（或替你登录还没开）：照实说要先在网站上登录。
    CREDENTIAL_PAGE: '这一页要先登录。在网站上登录之后，再点「自动填写」。',
    RULES_MATCHED_NOTHING: '这一页暂时认不出申请表。请刷新后再试。',
    PATH_NOT_APPLY: '这一页不是申请表。打开申请表页面后再点自动填写。',
    ROOT_NOT_FOUND: '这一页暂时认不出申请表。请刷新后再试。',
    APPLY_FORM_NOT_OPENED: '这一页的申请表还没打开：先点页面上的申请按钮（例如「Apply for This Job」），表单出现后再点自动填写。',
    // 2026-10-04：申请表嵌在这一页的一个 iframe 里（公司官网嵌 Greenhouse），那一帧有自己的浮层。
    IN_EMBEDDED_FRAME: '申请表嵌在这一页下方的那一块里，那里有它自己的 Career Companion 按钮。滚到申请表，在那里按「自动填写」。',
    NO_KEYED_FIELD: '这一页的问题我们暂时都填不了，请直接在网站上填写。',
    NOT_SEALABLE: '页面还在变化，这次没有填。请刷新页面后再试。',
    SCAN_NOT_SEALABLE: '页面还在变化，这次没有填。请刷新页面后再试。',
    NO_AUTHORIZED_FIELD: '这一页的问题需要你自己在网站上填写。',
    GESTURE_UNTRUSTED: '没能开始，请再点一次自动填写。',
    GESTURE_FOREIGN: '没能开始，请再点一次自动填写。',
    CAPABILITY_DISABLED: '这一页的问题暂时需要你自己填写。',
    NOT_FOUND: '页面还没加载完。请刷新后再试。',
    PLAN_STALE: '页面刚刚变化了。请再点一次自动填写。',
    LEASE_INVALID: '页面刚刚变化了。请再点一次自动填写。',
    TIMED_OUT: '还没确认填写结果，请在网站上检查一遍。',
    WORKER_UNREACHABLE: '插件没有响应。请刷新页面后再试。',
    STOPPED: '填写已停止，请在网站上检查已经填好的内容。',
    AUTHORITY_UNAVAILABLE: '暂时连不上 Career Companion，没能开始填写。请稍后刷新页面再试。',
    RUN_UNAVAILABLE: '自动填写暂时不可用，请稍后刷新页面再试。',
    PROFILE_UNAVAILABLE: '暂时读不到你的资料，所以这一页没有填。稍后再试，或先去 Career Companion 检查资料。',
    // 2026-10-04：档案读得太慢（每个请求 8 秒、整份 15 秒），或门户正在保存档案（argoland #710 的读锁，等了约 1 秒再读也还在保存）。
    PROFILE_TIMEOUT: 'Career Companion 这次回得太慢，没读到你的资料，这一页没有填。稍后再点一次「自动填写」。',
    PROFILE_BUSY: '你的资料正在保存（可能刚在 Career Companion 改过），这一页还没填。等几秒再点一次「自动填写」。',
  } as Record<string, string>,

  /** worker 交回「剩下的要你来」而没有逐栏的行时（mission 那条路）。 */
  handBack: { title: '还有问题需要你', sub: '剩下的问题需要你在网站上完成。' },

  /**
   * 认得的诊断码换一句人话，挂在总结下面（按前缀匹配，长的先）：简历附的是哪一版、为什么没附上、
   * EEO 答案读不到。码本身只进失败卡的「技术细节」。
   */
  diagnosticsHints: {
    // 2026-09-28 起挂在简历那一栏上（挂不上才留在总结下面）：说他照着做就好的一句。
    RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY: '简历没附上：这一版还没有 PDF（上传的不是 PDF，或还没生成好）。去 Career Companion 上传或生成一份 PDF，再点一次自动填写。',
    RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_RESUME_VERSION_NOT_FOUND: '简历没附上：你的默认简历在 Career Companion 里已经没有了。去简历页重新选一份默认简历。',
    RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE: '简历没附上：这一版此刻拿不到（可能还在生成）。稍后再点一次自动填写，或去 Career Companion 换一版。',
    RESUME_ATTACHMENT_NO_RESUME: '简历没附上：你的 Career Companion 账号里还没有简历。先去简历页上传或生成一份。',
    RESUME_ATTACHMENT_RESUME_CHOICE_REQUIRED: '简历没附上：你有好几份简历，还没选默认的。在「我的资料」里选一份。',
    RESUME_ATTACHMENT_PLAN_TARGET_NOT_ALLOWED: '简历没附上：这个网站还不能接收简历附件，请在网页上自己附。',
    EEO_ANSWERS_FETCH_FAILED: '自我认同那几题没有预填：暂时读不到你保存的答案，这几题请自己选。',
  } as Record<string, string>,
  /** 附上的是哪一版（诊断码说了算）：写在「其余已填好」里简历那一行的值后面（2026-09-28 起不在总结里）。 */
  resumeVersion: {
    RESUME_ATTACHMENT_PREPARED_FOR_JOB: '附上的是为这个岗位改过的那一版',
    RESUME_ATTACHMENT_DEFAULT_VERSION: '附上的是你的默认简历',
  } as Record<string, string>,

  /**
   * 「我的资料」宽版编辑器（设计 18 号画面）：分组、卡片标题、每一栏的标签与选项、保存栏与确认框。
   * 选项只换看得见的那几个字；存进草稿的值不跟着语言变（办公模式、学位的值仍是 `profileModel` 里那几个词）。
   */
  profile: {
    groups: { personal: '个人', job: '求职', history: '经历', settings: '申请设置' },
    sections: {
      basic: '基本资料', addr: '地址', links: '链接', auth: '工作许可', prefs: '求职偏好', qa: '常见问题',
      exp: '工作经历', edu: '教育', skills: '技能与语言', resume: '默认简历', consent: '代填授权', eeo: '自我认同',
    },
    fields: {
      first: '名', last: '姓', preferred: '称呼', pronouns: '代词', email: '邮箱', phone: '电话',
      line1: '街道地址', city: '城市', region: '州或地区', postal: '邮编', country: '国家',
      portfolio: '作品集', website: '个人网站',
      workAuth: '你是否有在美国工作的合法身份？', sponsor: '现在或将来是否需要签证担保？', over18: '是否年满 18 岁？',
      salary: '期望薪资', modes: '可接受的办公模式', start: '最早到岗日期', notice: '离职通知期', relocate: '是否愿意搬迁？',
      cities: '愿意搬迁去的城市', referral: '你通常从哪里看到这类职位', summary: '个人简介',
      title: '职位', company: '公司', loc: '地点', current: '目前在职', from: '开始', to: '结束', desc: '工作内容',
      // 教育经历的「在读」（2026-10-04）：开着时「结束」那一格是预计毕业时间。
      inSchool: '在读', expectedGraduation: '预计毕业',
      school: '学校', degree: '学位', major: '专业', skills: '技能', langs: '语言',
      gender: '性别', hispanic: '是否 Hispanic / Latino', race: '种族／族裔（可多选）', veteran: '受保护退伍军人身份',
      disability: '残障状况', eeoReuse: '申请时使用这些答案',
    },
    options: {
      unset: '未选择', preferNotToSay: '不愿回答', yes: '是', no: '否',
      authorized: '有', notAuthorized: '没有', sponsorNo: '不需要', sponsorYes: '需要', relocateYes: '愿意', relocateNo: '不愿意',
      countries: { US: '美国', CA: '加拿大', CN: '中国', GB: '英国' },
      workModes: { REMOTE: '远程', HYBRID: '混合', ONSITE: '现场' },
      referral: { companySite: '公司官网', referral: '内推', jobBoard: '招聘网站', other: '其他' },
      degrees: { ASSOCIATE: '副学士', BACHELOR: '学士', MASTER: '硕士', PHD: '博士' },
      periods: { year: '每年', month: '每月', hour: '每小时' },
    },
    /** 自我认同的选项：值是门户那几句英文原文（不变），这里只是按钮上的字。 */
    eeo: {
      woman: '女', man: '男', decline: '不愿回答',
      asian: '亚裔', white: '白人', black: '黑人／非裔', nativeAmerican: '美洲原住民', pacificIslander: '太平洋岛民',
      notVeteran: '不是', veteran: '是', noDisability: '没有', disability: '有',
      caption: '只在申请表问到时使用，每一项都可以选「不愿回答」。',
    },
    /** 语言那一栏的标签写成「日本語 · 基础」：后半截是熟练程度（`profileModel` 按这几个词读回来）。 */
    proficiency: { NATIVE_OR_BILINGUAL: '母语', PROFESSIONAL: '流利', CONVERSATIONAL: '日常交流', BASIC: '基础' },
    /**
     * 代填授权那一格（2026-09-28，文案版本 `application-signing-2026-09-28`，负责人定稿）：一句话，与门户资料页
     * `Onboarding.form.signingConsent` 的中文逐字相同（门户那一句里「隐私政策」是链接）。每一类具体是什么写在 argoland
     * 隐私政策里版本号相同的那一节（`consentScopePage` 打开它）；范围一改，那一节与文案版本一起升，旧版本的同意不覆盖
     * 新加的类别——只有当前版本算数。
     */
    consentLabel: '允许 ArgoLand 以我的名义处理申请表上的条款、声明和授权，并替我注册、登录招聘网站。详见隐私政策。',
    /** 那一句里点得开的那几个字（打开隐私政策里写明范围的那一节）。 */
    consentLinkText: '隐私政策',
    /** 隐私政策里写明范围的那一节（中文页）。 */
    consentScopePage: 'SIGNING_SCOPE_ZH' as DockPortalPage,
    /** 资料编辑器那一节下面的一行：点开同一节。 */
    consentScopeCta: '在隐私政策里查看代填的范围',
    optional: '选填',
    cityPlaceholder: '输入城市，按回车添加',
    tagPlaceholder: '输入后按回车添加',
    langPlaceholder: '例如：日本語 · 基础',
    addExperience: '添加一段经历',
    addEducation: '添加教育经历',
    discard: '放弃修改',
    save: '保存',
    saving: '保存中…',
    leaveTitle: (count: number) => `有 ${count} 项修改还没保存`,
    leaveSub: '离开前要保存吗？',
    present: '至今',
    /** 在读的教育在条目副标题里写「预计 2027.05」。 */
    expected: '预计',
    removeTag: '删除',
    decrease: '减少',
    increase: '增加',
    notSet: '未填',
    days: (count: number) => `${count} 天`,
    countryCode: '国际区号',
    currency: '币种',
    payPeriod: '薪资周期',
    manageResumes: '在 Career Companion 管理简历',
    resumesUnavailable: '暂时读不到你的简历列表。',
    noResumes: '你的账号里还没有简历。',
    currentDefault: '当前默认',
    /** 默认简历那一张卡上的小字：版本名后面的「几月几日更新」。 */
    resumeUpdated: (month: number, day: number) => ` · ${month} 月 ${day} 日更新`,
    removeEntry: '删除这一段',
    newExperience: '新的经历',
    newEducation: '新的教育经历',
    openToFill: '点开填写',
    sectionUnavailable: '暂时读不到这一项。可以在 Career Companion 网页端修改。',
    entryCount: (count: number) => `${count} 段`,
    on: '已开启',
    off: '未开启',
    statusSaving: '正在保存…',
    statusDirty: (count: number) => `${count} 项修改未保存`,
    statusSaved: '已保存',
    statusClean: '所有修改都已保存',
    /** 先显示旧的、后台换新（2026-10-04）：后台正在对；没对上时说摆的是多久以前读到的。 */
    statusChecking: '正在更新…',
    statusStale: (minutes: number) => (minutes < 1 ? '没能更新，这是刚才读到的资料' : `没能更新，这是 ${minutes} 分钟前读到的资料`),
    retry: '重试',
    /** 先摆出来的那一份里没有这一节，后台还在读。 */
    sectionLoading: '正在读取…',
    hudSaved: '已保存',
    hudSaving: '正在保存',
    loading: '正在读取你的资料…',
    loginExpired: '登录已过期，重新登录后再打开这一页。',
    unavailable: '暂时读不到你的资料，稍后再试。',
    /** 读得太慢（TIMEOUT）、门户正在保存档案（BUSY，argoland #710 的锁）：各说各的（2026-10-04）。 */
    slow: 'Career Companion 这次回得太慢，没读到你的资料。稍后再试。',
    busy: '你的资料正在别处保存，等几秒再打开这一页。',
    /** 读不到时下面那一行：只有稳定的原因码，不含任何值（2026-09-27）。 */
    unavailableCode: (code: string) => `找我们帮忙时附上这一串：${code}`,
    editInPortal: '在 Career Companion 里编辑',
    needsFixing: (count: number) => `有 ${count} 项需要修改`,
    saveFailed: '暂时保存不了，请稍后再试。',
    /** 别处一直在改：合了几次还是撞上（2026-10-04 起不再整份重读、丢掉他的修改）。 */
    saveStale: '资料在别处一直在改。你的修改还在，稍后再保存一次。',
    /** 别处刚存过、重读也读不到。 */
    saveStaleUnread: '资料刚在别处改过，暂时读不到最新的一版。你的修改还在，稍后再保存一次。',
    /** 别处刚存过，他改的已经放到最新的一版上存好了。 */
    saveMerged: '资料刚在别处改过：已把你的修改放到最新的一版上保存。',
    /** 存到一半换了账号登录（2026-10-04）：上一个人的修改一个字都没再发。 */
    saveSessionChanged: '已经换了账号登录：这些修改没有存。',
    /** 同一项两边都改了（2026-10-04）：每一项选一下留哪一个。 */
    conflict: {
      title: '这几项在别处也改过',
      sub: '每一项选一下要留哪一个，再保存。',
      mine: (value: string) => `你刚改的：${value}`,
      theirs: (value: string) => `别处的：${value}`,
      save: '保存',
      cancel: '稍后再说',
      empty: '（空）',
      removed: '（删掉这一段）',
      joiner: '、',
    },
    saveLogin: '登录已过期，重新登录 Career Companion 后再保存。',
    saveInvalid: '有一项格式不对，没能保存。请检查电话、邮箱与链接。',
    /** 存的那一下到点没答：可能已经存上了，也可能没有（2026-10-04）。 */
    saveTimeout: 'Career Companion 这次回得太慢，不确定存上没有。你的修改还在，稍后再点一次保存。',
    saveBusy: '你的资料正在别处保存。你的修改还在，等几秒再点一次保存。',
    /** 保存前的检查（`profileModel.validate`）。 */
    errors: {
      first: '请填写名。',
      last: '请填写姓。',
      email: '邮箱格式不对，请检查一下。',
      phone: '电话号码看起来不完整。',
      salary: '只填数字，例如 170000。',
      url: '链接看起来不完整，例如 linkedin.com/in/你的名字。',
      title: '请填写职位。',
      company: '请填写公司。',
      school: '请填写学校。',
    },
  },
};

type DeepReadonly<T> = T extends (...args: never) => unknown ? T : { readonly [K in keyof T]: DeepReadonly<T[K]> };

/** 浮层的一整套文案（中英两套同一个形状）。 */
export type DockCopy = DeepReadonly<typeof zh>;

const en: typeof zh = {
  product: 'Career Companion',
  launcher: 'Open Career Companion',
  launcherWithNeeds: (value) => `Open Career Companion, ${value} ${needVerb(value)} you`,
  hideLauncher: 'Hide button',
  hidden: 'Hidden. Reload the page to bring it back.',
  collapse: 'Collapse',
  account: 'Account',
  back: 'Back',
  profileTitle: 'My profile',
  more: 'More',

  launcherState: {
    preparing: 'Preparing',
    filling: (done, total) => `Filling ${done}/${total}`,
    aiFilling: 'AI is filling',
    needs: (value) => `${value} ${needVerb(value)} you`,
    allDone: 'All filled',
    review: 'Review page',
    ready: 'Autofill',
    idle: 'Career Companion',
  },

  vendorFallback: 'Application form',
  jobFallback: (ats) => (ats === null ? 'Job application' : `${ats} application`),
  submittedTag: 'Submitted',

  jobCard: {
    detail: 'View full job details',
    today: 'Today',
    daysAgo: (days) => `${plural(days, 'day')} ago`,
    monthsAgo: (months) => `${plural(months, 'month')} ago`,
    yearsAgo: (years) => `${plural(years, 'year')} ago`,
    per: (currency, unit) => `${currency} / ${({ YEAR: 'year', MONTH: 'month', WEEK: 'week', DAY: 'day', HOUR: 'hour' } as const)[unit]}`,
    workMode: { REMOTE: 'Remote', HYBRID: 'Hybrid', ONSITE: 'On-site' },
    employment: { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACT: 'Contract', INTERNSHIP: 'Internship' },
    highlightsAria: 'Where you match',
  },

  autofill: 'Autofill',
  submitted: 'Submitted',

  faces: {
    unlinked: {
      title: 'Connect Career Companion and fill applications in one click',
      sub: 'We fill in the details you saved in Career Companion, and you can review everything before you submit.',
      primary: 'Sign in to Career Companion',
    },
    linking: {
      title: 'Waiting for you to sign in to Career Companion',
      sub: 'Career Companion is open in a new tab. Sign in, then come back here and we’ll pick up automatically.',
      ghost: 'Cancel',
    },
    dormant: {
      title: 'This is a job details page',
      sub: 'Open the application form and we can fill it in.',
      primary: 'Open application form',
    },
    noForm: {
      title: 'No application form on this page yet',
      sub: 'Once the form appears, we can fill it in.',
    },
    rules: {
      title: 'Can’t tell yet whether this page can be autofilled',
      sub: 'Try again in a moment. Your profile isn’t affected.',
      secondary: 'Check again',
      checking: 'Checking…',
    },
    closed: {
      title: 'Autofill isn’t available for this kind of site yet',
      sub: 'Career Companion hasn’t turned on autofill for this kind of site yet. You can fill it in on the site as usual; your profile isn’t affected.',
    },
    signin: {
      title: (ats) => (ats === null ? 'Sign in on this site first' : `Sign in to ${ats} first`),
      sub: 'You create the account and password on the site yourself. Once you sign in, we’ll continue here automatically.',
      waiting: 'Waiting for you to sign in',
    },
  },

  run: {
    filling: 'Filling',
    nextPage: 'On the next page, filling it now…',
    readingForm: 'Reading the form',
    matchingProfile: 'Matching your profile',
    matchingOptions: 'Matching options',
    section: (kind, number, total) => `Filling ${kind === 'experience' ? 'work experience' : 'education'} ${number}/${total}`,
    waitingAi: 'Waiting for AI',
    writingLetter: 'Writing your cover letter',
    confirmingShort: 'Checking the site kept it',
    writing: 'Filling…',
    confirming: 'Checking what was filled…',
    checked: 'Checked',
    stop: 'Stop',
    summaryPreparing: 'Preparing…',
    required: (done, total) => `Required ${done}/${total}`,
    scanning: (controls) => `Reading the form · ${plural(controls, 'field')} so far`,
    composing: (observable, authorized) => `We can answer ${authorized} of ${plural(observable, 'question')}`,
    nothingRequired: 'This form has no required fields for us to fill',
  },

  summary: {
    review: { title: 'You’ve reached the review page', sub: 'Nothing to fill on this page. Once it all looks right, you can submit.' },
    stopped: { title: 'Filling stopped', sub: (filled) => `Filled ${plural(filled, 'field')}. Please finish the rest on the site.` },
    needs: (value, page) => `${plural(value, 'field')} ${page ? 'on this page ' : ''}still ${needVerb(value)} you`,
    allDone: { title: 'All required fields are filled', sub: 'Look it over, then submit when it all looks right.' },
    pageDone: { title: 'This page is filled', sub: 'Continue and it keeps filling the next page.' },
    filledSub: (filled, ai) => `${filled} filled${ai > 0 ? `, ${ai} by AI` : ''}`,
    nothing: { title: 'Nothing on this page needs you', sub: 'Look it over, then submit when it all looks right.' },
  },
  sentences: (first, second) => `${first}. ${second}`,

  chain: {
    status: (page, total, step) => `Page ${page}${total === null ? '' : ` of ${total}`}: ${step === null ? 'filling' : `filling “${step}”`}`,
    filled: (page, total) => `Page ${page}${total === null ? '' : ` of ${total}`}: filled`,
    advancing: 'Going to the next page…',
    pressing: (label) => `Pressing the site’s “${label}”`,
    doneTitle: 'Everything is filled',
    doneSub: (pages, fields, onSite) =>
      `Filled ${pages} pages in a row${fields > 0 ? `, ${plural(fields, 'field')} in all` : ''}. Look it over, then ${onSite ? 'submit on the site' : 'press “Submit”'}.`,
    sofar: (pages) => (pages === 1 ? 'Page 1 is filled.' : `The first ${pages} pages are filled.`),
    needsNext: 'Once they’re done, press “Continue to next page” and it keeps filling.',
    walls: {
      LOGIN: { title: 'The site wants you to sign in', sub: 'Sign in on the site, then press “Continue to next page” to keep filling.' },
      VERIFICATION: { title: 'The site wants a verification code', sub: 'Enter the code on the site, then press “Continue to next page” to keep filling.' },
      CAPTCHA: { title: 'The site wants you to prove you’re human', sub: 'Finish the check on the site, then press “Continue to next page” to keep filling.' },
    },
    pageCap: (pages) => `Filled ${pages} pages in a row, so it stops here. Look it over, then press “Continue to next page” to keep going.`,
    timeCap: 'This run has been filling for a few minutes, so it stops here. Look it over, then press “Continue to next page” to keep going.',
    unavailable: 'This page is filled, but we can’t tell which button on the site goes to the next step. Click it on the site, then press “Autofill” on the next page to keep filling.',
    siteErrors: { title: 'The site flagged a problem on this page', sub: 'Check the site’s red messages and fix them, then press “Continue to next page” to keep going.' },
    blocked: {
      LOGIN: { title: 'The site wants you to sign in', sub: 'Sign in on the site, then press “Try again” to keep filling.' },
      VERIFICATION: { title: 'The site wants a verification code', sub: 'Enter the code on the site, then press “Try again” to keep filling.' },
      CAPTCHA: { title: 'The site wants you to prove you’re human', sub: 'Finish the check on the site, then press “Try again” to keep filling.' },
      UNKNOWN_PAGE: { title: 'This page needs you', sub: 'We can’t tell what to fill on this page. Fill it on the site, go to the next page, then press “Try again” to keep filling.' },
      UNAVAILABLE: { title: 'Can’t read this page right now', sub: 'We couldn’t tell whether this page needs something from you. Check the site, then press “Try again”.' },
    },
  },

  blockedFaces: {
    VENDOR_CLOSED: { title: 'Autofill isn’t available for this kind of site yet', sub: 'Career Companion hasn’t turned on autofill for this kind of site yet. You can fill it in on the site as usual; your profile isn’t affected.' },
    CONSENT_GATE: { title: 'First, get past the site’s data consent step', sub: 'Choose where you live on the page, read the terms and accept them, and the application form will appear. Then press “Try again”.' },
    CONSENT_GATE_ACCEPT: { title: 'We chose where you live — please read the terms and accept', sub: 'The site is showing its terms on the page: read them and accept (for example “Accept”), and the application form will appear. Then press “Try again”.' },
    APPLY_FORM_NOT_OPENED: { title: 'The application form isn’t open yet', sub: 'First click the site’s apply button (such as “Apply for This Job”), then press “Try again” once the form appears.' },
  } as Record<string, { title: string; sub: string }>,

  failed: {
    network: { title: 'Can’t reach Career Companion right now', sub: 'Filling couldn’t start. Try again in a moment.' },
    unknown: { title: 'This run didn’t finish', sub: 'Try again. If it still doesn’t work, reload the page and try once more.' },
    retry: 'Try again',
    tech: 'Technical details',
    copy: 'Copy',
    copied: 'Copied. You can send it to us as is.',
    copyFailed: 'Couldn’t copy. Select the code above and copy it by hand.',
    openForm: 'Open application form',
  },

  updated: {
    title: 'Career Companion was updated',
    sub: 'Reload this page to continue. Some sites clear what you’ve entered when the page reloads.',
    reload: 'Reload page',
  },

  banner: {
    stuck: {
      title: 'The site didn’t go to the next page',
      text: (value) => `${plural(value, 'required field')} on this page ${value === 1 ? 'is' : 'are'} still empty. Check the red messages on the site, fix them, then continue.`,
      filled: 'Check the site’s messages first: if a field is marked red, fix it and continue. If the page shows an error (such as an Error Code), the site session has probably expired; reload the page and try again.',
    },
    fixed: { title: 'All fixed', text: 'Press “Continue to next page” again.' },
    notSubmitted: {
      title: 'The site didn’t submit',
      text: 'Check the red messages on the site, fix them, then press “Submit” again.',
    },
    unconfirmed: {
      title: 'No confirmation from the site yet',
      text: 'Check on the site whether it went through before you decide to submit again.',
    },
  },

  lists: {
    signed: 'Filled on your behalf',
    signedNote: 'Based on what you allowed and answered in your profile. Please review before you submit.',
    rest: 'Also filled',
    optional: 'Optional',
    yourData: 'Your profile',
    locateAria: (question) => `${question}, find this question on the page`,
    youFilled: 'You filled this',
    alreadyThere: 'Already on the page, left as is',
    fromResume: 'The site read this from your résumé',
    valueJoin: ', ',
  },

  needs: {
    groups: { choose: 'Pick one', write: 'Write a few lines', missing: 'Not in your profile', decide: 'Your call', check: 'Check on the page', review: 'Check before you submit' },
    more: 'More options',
    go: 'Go to field',
    goPick: 'Pick on the page',
    goWrite: 'Write on the page',
    fill: 'Fill in',
    filling: 'Filling in…',
    placeholder: 'Type your answer',
    choosePlaceholder: 'Choose…',
    aiWrite: 'Write it with AI',
    aiWriting: 'AI is writing…',
    aiFill: 'Fill in AI draft',
    chipAria: (option) => `Choose “${option}”`,
    inputAria: (question) => `Answer for “${question}”`,
    why: {
      noMatch: (hint) => (hint === null ? 'No option matches your profile. Pick the closest one' : `No option says “${hint}”. Pick the closest one`),
      ambiguous: (hint) => (hint === null ? 'A few options could fit. Pick one' : `A few options look like “${hint}”. Pick one`),
      incomplete: 'Couldn’t read all the options. Pick one, or see them all on the page',
      notLoaded: 'The site’s options didn’t load. Pick one on the page',
      suggested: 'Suggested from the job location. Tap to confirm',
      jobDependent: 'Depends on this job. Pick one',
      missing: 'Not in your profile yet',
      missingChoice: 'Your profile has no answer for this. Pick one',
      unknown: 'We didn’t recognize this question. Answer it here',
      openQuestion: 'An open question. A few lines in your own words',
      aiNothing: 'AI found nothing in your profile for this. Write a few lines yourself',
      aiMissed: 'AI couldn’t answer this time. Try again',
      aiUsedUp: 'You’re out of AI answers this month. Write a few lines yourself',
      eeoUnavailable: 'Couldn’t load your saved answer just now. Just pick one on the page',
      employer: 'Answer once. We’ll save it to your profile and answer it for you next time',
    },
    employer: {
      yes: 'Yes',
      no: 'No',
      saved: 'Saved to your profile. We’ll answer this for you next time',
      notSaved: 'Filled in, but we couldn’t save it to your profile. We’ll ask again next time',
    },
    answered: 'You answered',
    answerFailed: {
      UNTRUSTED: 'That tap didn’t come through. Please tap again',
      ENDED: 'This fill has ended. Please answer it on the page',
      CHANGED: 'This field just got an answer, so it wasn’t overwritten',
      REFUSED: 'Couldn’t fill it in. Please answer it on the page',
    },
  },

  tally: {
    filled: (count) => `${count} filled`,
    ai: (count) => `${count} by AI`,
    needs: (count) => `${count} need you`,
    kept: (count) => `${count} left to you`,
  },

  letter: {
    writing: 'Writing a cover letter for this job…',
    readyRow: 'Cover letter ready. Use “Attach cover letter” above',
    readyTitle: 'Your cover letter is ready',
    readyText: 'Written for this job. Once attached, you can read it on the page and edit it before you submit.',
    attach: 'Attach cover letter',
    attaching: 'Attaching…',
    attached: 'Attached a cover letter written for this job',
    attachFailed: 'Couldn’t attach it. Please add your cover letter yourself',
    refused: {
      NEEDS_PAGE_JOB: 'Couldn’t read this job’s description. Please add your cover letter yourself',
      JOB_TEXT_UNUSABLE: 'This page’s job description can’t be used for a letter. Please add yours yourself',
      PROFILE_UNAVAILABLE: 'Your profile doesn’t have enough for a cover letter yet. Add your experience in Career Companion',
      AUTH_REQUIRED: 'Your sign-in expired. Sign in to Career Companion again for a cover letter',
      PAYWALL_REQUIRED: 'Cover letters need a membership. Please add yours for now',
      USAGE_EXHAUSTED: 'You’ve used this month’s cover letters. Please add yours yourself',
      TARGET_NOT_ALLOWED: 'This site can’t take a cover letter from us yet. Please add yours yourself',
      UNAVAILABLE: 'The cover letter didn’t come through this time. Please add yours yourself',
    },
  },
  memory: {
    switchLabel: 'Remember answers',
    switchOn: 'On: answers you give here fill in next time',
    switchOff: 'Off: answers you give here won’t be remembered',
    switchFailed: 'Couldn’t save this setting. Please try again later.',
    noted: 'Remembered for next time · Turn it off in the menu',
  },
  ai: {
    group: 'AI answers',
    groupNote: 'Drafted from your saved profile. Please review before you submit; you can turn this off in the account menu.',
    drafting: (value) => (value > 0 ? `AI is filling ${plural(value, 'question')} from your profile…` : 'AI is filling from your profile…'),
    noEvidence: 'AI found nothing in your profile to answer this',
    unanswered: 'AI couldn’t answer this one this time',
    applied: (value) => `AI answered ${plural(value, 'field')}. Please review before you submit`,
    readyTitle: (value) => `AI drafted answers to ${plural(value, 'question')}`,
    readyText: 'Drafted from your saved profile. Click to fill them in, then review before you submit.',
    readyButton: 'Fill in AI answers',
    applying: 'Filling in…',
    applyFailed: 'Couldn’t fill in the AI answers. Please answer these yourself.',
    filled: (filled, ai) => `${filled} filled${ai > 0 ? ` (${ai} by AI)` : ''}`,
    rephrase: 'Rephrase',
    rephrasing: 'Rephrasing…',
    rephraseFill: 'Fill in new wording',
    rephrased: 'Rephrased. Please review before you submit',
    switchLabel: 'AI answers',
    switchOn: 'AI answers turned on',
    switchOff: 'AI answers turned off',
    switchFailed: 'Couldn’t save the AI answers setting. Please try again later.',
    chip: {
      write: 'Write with AI',
      revise: 'Revise with AI',
      writeAria: 'Write this answer with AI',
      reviseAria: 'Revise this answer with AI',
    },
    card: {
      writeTitle: 'Write this answer with AI',
      reviseTitle: 'Revise this answer with AI',
      placeholder: 'Tell AI what to add, change, or improve',
      cancel: 'Cancel',
      generate: 'Generate',
      generating: 'Generating…',
      fill: 'Fill in',
      remaining: (value) => `${plural(value, 'use')} left this month`,
      usedUp: 'You’ve used all your AI uses this month',
      usedUpUntil: (month, day) => `You’ve used all your AI uses this month. They reset on ${monthName(month)} ${day}`,
      upgrade: 'Upgrade',
      unavailable: 'Not available right now. Please try again later',
      login: 'Your sign-in expired. Sign in to Career Companion again and retry',
      changed: 'This field just changed, so it wasn’t overwritten',
      pageChanged: 'The page just changed. Please try again',
      untrusted: 'That tap didn’t come through. Please tap again',
      tooLong: 'This field is too long for AI to revise',
      switchedOff: 'AI answers are off. You can turn them on in the account menu',
      expired: 'It’s ready. Click “Fill in” to put it in this field',
      written: 'Written into this field. Please review before you submit',
    },
  },

  emailCode: {
    title: 'The site emailed you a verification code',
    ask: (site, inbox, from, more, subject, length) =>
      `${site} wants to confirm this application is really yours. Check ${inbox === null ? 'the inbox you applied with' : `the inbox for ${inbox}`} for an email from ${from}${more ? ' (or a similar address)' : ''}${subject === null ? '' : ` with a subject starting “${subject}”`}, and paste the ${length}-character code below. Not there? Check spam.`,
    placeholder: (length, digits) => `${length}-${digits ? 'digit' : 'character'} code`,
    enter: 'Enter on the site',
    entering: 'Entering…',
    privacy: 'We don’t read your email: only you type the code, and it goes only into this page.',
    errors: {
      WRONG: { title: 'That code didn’t work', sub: 'The site says the code is wrong. Check the email and type it again (watch for upper and lower case, and look-alikes such as 0 and O, 1 and l).' },
      EXPIRED: { title: 'That code has expired', sub: 'The site says the code has expired. Look for a newer email and enter the new code below; if there isn’t one, follow the note on the site.' },
      TOO_MANY: { title: 'Too many tries', sub: 'The site says there were too many tries. Follow the note on the site and try again later.' },
      OTHER: { title: 'The site didn’t accept the code', sub: 'Check the email and type it again, or follow the note on the site.' },
    },
    siteSays: (text) => `The site says: “${text}”`,
    filled: {
      title: 'Code entered on the site',
      resubmitHere: 'Now press “Submit” below to send it again.',
      resubmitOnSite: 'Now click Submit on the site again.',
      verify: 'Now click Verify on the site.',
    },
    notes: {
      FORMAT: (length, digits) => `The code should be ${length} ${digits ? 'digits' : 'letters or digits'}. Check it and try again.`,
      GONE: 'The code box isn’t on the site any more.',
      OFF: 'We can’t enter it this time. Please type the code on the site.',
      UNTRUSTED: 'We couldn’t confirm that click was yours. Please click again.',
      FAILED: 'Couldn’t enter it on the site. Please type the code there.',
    },
  },

  siteAccount: {
    vaultList: {
      loading: 'Loading saved sites…', empty: 'No accounts linked to a site yet.', unavailable: 'Saved sites are unavailable. Please try again later.',
      keyMissing: 'The local key is missing. These passwords cannot be recovered; reset them on each site.', unreadable: 'Saved data could not be read. Reset the passwords on each site.',
      pending: 'Registration unfinished', registered: 'Registered', saved: 'Password saved', needsPassword: 'Password needed',
      manage: 'Open extension settings / export', view: 'View in extension settings', note: 'Export before switching computers or clearing browser data. View passwords only in extension settings.',
    },
    site: (company, vendor) => (company === '' ? vendor : `${company}’s ${vendor}`),
    register: 'Sign up & autofill',
    signIn: 'Sign in & autofill',
    wallNote: (site) => `${site} needs an account first. We’ll sign you up or sign you in with your email, then keep filling.`,
    status: {
      PREPARING: (site) => `Getting ready to sign in to ${site}…`,
      CHOOSING: () => 'Choosing “Sign in with email”…',
      REGISTERING: (site) => `Creating your account on ${site}…`,
      SIGNING_IN: (site) => `Signing you in to ${site}…`,
      IDENTIFYING: (site) => `Signing in to ${site} with your email…`,
    },
    done: {
      REGISTERED: (site, email) => `Created your account on ${site} (${email})`,
      generated: 'Made a separate password for this site. It stays on this computer; view it under “Job site accounts” in extension settings',
      SIGNED_IN: (site, email) => `Signed you in to ${site} (${email})`,
      ACCOUNT_EXISTS: (site) => `You already have an account on ${site}. Enter this site’s password to continue`,
      TERMS_ACCEPTED: (site) => `Accepted the terms ${site} requires for signing up`,
    },
    continuing: 'Signed in. Filling in the application…',
    prompts: {
      SITE_PASSWORD: {
        title: (site) => `Your ${site} password is different`,
        sub: (email) => `This site already has an account for ${email}. Enter that site’s password below (it stays on this computer) and we’ll sign you in.`,
        retrySub: 'That password didn’t work either. Try again, or reset it on the site.',
        placeholder: 'This site’s password',
        primary: 'Sign in with this password',
        forgot: 'Forgot it? Click “Forgot your password?” on the site, reset it from the email, then enter the new one here.',
      },
      VERIFY_EMAIL: {
        title: 'Click the link in your email',
        sub: (site, email, from) =>
          `${site} sent a verification email to ${email}${from === null ? '' : ` (usually from ${from})`}. Click the link and return to this page. If you still need to sign in, we’ll ask for this site’s password. Not there? Check spam.`,
        primary: 'I’ve verified, continue',
      },
      CONSENT: {
        title: 'Turn on acting on your behalf first',
        sub: 'To sign up or sign in to job sites for you, tick the on-your-behalf permission in My profile (see the Privacy Policy). Or sign in on the site yourself, then press “Autofill”.',
        primary: 'Open my profile',
      },
      OFF: {
        title: (site) => `Sign in to ${site} first`,
        sub: 'This version can’t sign up or sign in for you yet. Sign in (or sign up) on the site, then press “Autofill” to keep filling.',
      },
      NO_EMAIL: {
        title: 'Can’t confirm the sign-in email',
        sub: 'For a new account, check the email in your profile. If you already have an account on this site, sign in there yourself, then press “Autofill”.',
        primary: 'Open my profile',
      },
      UNAVAILABLE: { title: 'Can’t sign you in right now', sub: 'Try again later, or sign in on the site yourself and press “Autofill” to keep filling.' },
      CAPTCHA: { title: 'The site wants you to prove you’re human', sub: 'Finish the check on the site and we’ll keep filling.' },
      VERIFICATION: { title: 'The site wants a verification code', sub: 'Enter the code on the site and we’ll keep filling.' },
      BLOCKED: { title: (site) => `Your ${site} account can’t sign in right now`, sub: 'It’s locked, or it only allows single sign-on (SSO). Sort it out on the site, then press “Try again”.' },
      REJECTED: { title: 'The site didn’t accept it', sub: 'Check the red messages on the site, fix them, then press “Try again”.' },
      NO_RESPONSE: { title: 'No answer from the site yet', sub: 'Take a look at the site; once it’s sorted, press “Try again”.' },
      TERMS_NEED_USER: { title: 'Please tick the sign-up terms yourself', sub: 'That box also asks for something beyond signing up (like marketing emails). Check it on the site, tick it, then press “Try again”.' },
      EXPIRED: { title: 'This run has expired', sub: 'Press “Try again” and we’ll keep signing you in.' },
      FAILED: { title: 'Couldn’t sign you in', sub: 'The site looks different from what we know. Sign in on the site yourself, then press “Autofill” to keep filling.' },
      CONTINUE_BY_HAND: { title: 'Signed in', sub: 'Press “Autofill” to fill this page.' },
    },
    retry: 'Try again',
    waiting: 'Waiting for you on the site',
    menu: { item: 'Job site accounts' },
  },

  signed: {
    TERMS_CONSENT: 'Agreed to the terms for you',
    TRUTH_ATTESTATION: 'Confirmed your answers are true for you',
    SIGNATURE_NAME: 'Signed with your name for you',
    SIGNATURE_DATE: 'Filled in the signing date for you',
    AI_RECORDING_CONSENT: 'Agreed for you: AI interview recording',
    SMS_CONSENT: 'Agreed for you: text messages',
    FUTURE_CONTACT_CONSENT: 'Agreed for you: future contact',
    MARKETING_CONSENT: 'Agreed for you: marketing messages',
    BACKGROUND_CHECK_CONSENT: 'Agreed for you: background check',
    ARBITRATION_AGREEMENT: 'Agreed for you: arbitration agreement',
    RECRUITING_DATA_SHARING: 'Agreed for you: recruiting vendors and affiliates may process your application',
    INFORMATION_VERIFICATION: 'Agreed for you: verifying the information you gave',
    SCREENING_CONSENT: 'Agreed for you: background screening (credit, drug test, driving record…)',
    AT_WILL_ACKNOWLEDGEMENT: 'Acknowledged for you: at-will employment',
    ARBITRATION_WAIVER: 'Agreed for you: arbitration, including the class and jury waivers',
    AI_INTERVIEW_ANALYSIS: 'Agreed for you: AI analysis of interview recordings',
    CALL_NOTIFICATION_CONSENT: 'Agreed for you: phone and WhatsApp updates',
    GROUP_FUTURE_CONTACT: 'Agreed for you: future contact from group companies',
    PRIVACY_NOTICE_TITLE: 'Acknowledged for you: privacy notice',
    COMBINED_CONSENT: 'Agreed for you: several items in one box, all within what you allowed',
    EMPLOYER_CONTACT_YES: 'Answered for you from your profile: may contact your current employer',
    EMPLOYER_CONTACT_NO: 'Answered for you from your profile: don’t contact your current employer',
    REFERENCE_CONTACT_YES: 'Answered for you, same as for your current employer: may contact',
    REFERENCE_CONTACT_NO: 'Answered for you, same as for your current employer: don’t contact',
  },

  reconsent: {
    title: 'Let Career Companion handle terms and authorizations for you?',
    lead: 'If you agree, the extension handles the terms, declarations and authorizations on application forms in your name and lists every item here. You can keep using it without agreeing; you’ll answer those yourself. If you agreed to an earlier version, please agree again.',
    agree: 'Agree',
    agreeing: 'Saving…',
    later: 'Not now',
    saved: 'Permission turned on',
    failed: 'Couldn’t save. Please try again later',
  },

  historyBasis: {
    ADULT_FROM_HISTORY: 'Inferred from your education and work history',
    EMPLOYER_IN_HISTORY: 'This company is in your work history',
    EMPLOYER_NOT_IN_HISTORY: 'This company isn’t in your work history',
    EMPLOYER_ENDED: 'Your time at this company has ended',
    NO_MILITARY_SERVICE_IN_HISTORY: 'No military service in your work history',
    STUDENT_FROM_EDUCATION: 'Inferred from your education (current study and graduation dates)',
    EXPERIENCE_YEARS_FROM_HISTORY: 'Counted from the dates in your work history',
    WORK_MODES_IN_PROFILE: 'Answered from the work arrangements you accept in your profile',
    LANGUAGES_IN_PROFILE: 'Answered from the languages in your profile',
    TRAVEL_IN_PROFILE: 'Answered from the travel limit in your profile',
  },

  entries: {
    AUTOFILL_INFORMATION: { title: 'My profile', sub: 'Name, contact details and address' },
    RESUME: { title: 'My résumé', sub: 'Manage your résumé versions in Career Companion' },
    COVER_LETTER: { title: 'Cover letter', sub: 'Written for this job and attached when you autofill' },
  },
  resumeDefault: (fileName) => `${fileName} · Default`,

  bar: {
    presses: (label) => `Presses the site’s “${label}” for you`,
    first: 'Go to first item',
    nextItem: 'Next item',
    next: 'Continue to next page',
    nextShort: 'Next page',
    advancing: 'Going to the next page…',
    submit: 'Submit',
    submitOnSite: 'Submit on the site',
  },

  menu: {
    openPortal: 'Open Career Companion',
    signOut: 'Sign out',
    language: 'Language',
    rerun: 'Fill this page again',
    editProfile: 'Edit my profile',
    home: 'Back to home',
    undo: 'Undo this fill',
  },

  toast: {
    nextPage: 'On the next page, filling it now',
    advanced: 'On the next page. Press “Autofill” to fill it.',
    pageChanged: 'The page moved to the next step. Press “Autofill” to fill it.',
    undone: 'Undone. This page is back to how it was before filling',
    connected: 'Connected to Career Companion',
    advanceUnavailable: 'The site’s “Next” can’t be pressed right now. Please click it on the site.',
    untrusted: 'That tap didn’t come through. Please tap again.',
    submitOnSite: 'Look it over, then click Submit on the site.',
    submitUnavailable: 'The site’s “Submit” can’t be pressed right now. Please click it on the site.',
    signedOut: 'Signed out.',
    signOutFailed: 'Can’t sign out right now. Please try again later.',
    portalOpened: 'Career Companion is open in a new tab.',
    portalFailed: 'Can’t open the career assistant right now. Please open the product website and try again.',
    openFormFailed: 'Can’t open the application form right now. Please use the Apply button on the site.',
  },

  unnamedRequired: 'A required question (we couldn’t read its wording)',
  consentGate: {
    choosing: 'We chose the option for where you live (from your profile) on the site’s data consent step and are waiting for the site to open the application form…',
    passed: 'We got you past the site’s data consent step: we chose the option for where you live (from your profile), and the site opened the application form.',
  },

  reasons: {
    LATE_REVERTED: 'The site changed this afterwards. Take a look',
    PLAN_STALE: 'The page just changed. Please fill this on the page',
    NO_VALUE: 'Not in your profile yet',
    MISSING_PROFILE: 'Not in your profile yet',
    MANUAL_ONLY: 'Only you can answer this one',
    OTHER_PERSON: 'It asks about someone else, so it’s yours to fill',
    JOB_DEPENDENT: 'The answer depends on this job',
    HOST_UNCONFIRMED: 'Filled, but the site didn’t confirm it. Take a look',
    CHOICE_NO_DATA: 'Your profile has no answer for this',
    NO_OPTION_MATCH: 'No option matches your profile',
    AMBIGUOUS_OPTION: 'More than one option could fit',
    UNSUPPORTED_CONTROL: 'We can’t fill this kind of field yet. Please fill it on the page',
    LOW_CONFIDENCE: 'We didn’t recognize this question',
    USER_ONLY: 'Open question, answer in your own words',
    HOST_REJECTED: 'The site says the format is wrong. Follow its hint on the page',
    ABORTED: 'Filling stopped before this field',
    POLICY_DISABLED: 'This version of the extension can’t fill this yet',
    DETACHED: 'The page just changed. Please fill this on the page',
    CAPABILITY_DISABLED: 'For now, this kind is yours to fill',
    PREFILLED_NEEDS_CONFIRMATION: 'Please confirm this one',
    CLICK_DENIED: 'You need to click this kind of option yourself',
    WIDGET_TIMEOUT: 'The site’s options didn’t load',
    IDENTITY_CHANGED: 'The page just changed. Please fill this on the page',
    TARGET_NOT_WRITABLE: 'This field won’t take input right now. Take a look on the page',
    VALUE_COERCED: 'The site changed the format. Take a look',
    NOT_FOUND: 'Can’t find this field on the page anymore',
    CONSENT_OFF: 'Filling agreements for you is off, so please tick this yourself',
    VERIFY_TIMEOUT: 'Filled, but the site didn’t confirm it in time. Take a look',
    WRITE_REVERTED: 'The site cleared what was filled. Please fill it on the page',
    NOT_EMPTY: 'Already filled on the page, left as is',
    OPTIONS_INCOMPLETE: 'Couldn’t read all the options for this question',
    DUPLICATE_FIELD: 'Same as another field; filled there instead',
    HOST_SUBMITTED: 'The site started submitting while we were filling. Take a look',
    GESTURE_UNTRUSTED: 'Your tap didn’t come through. Press Autofill again',
    GESTURE_FOREIGN: 'Your tap didn’t come through. Press Autofill again',
    GESTURE_EXPIRED: 'This fill has ended. Press Autofill again',
    GRANT_CONSUMED: 'This fill already ran. Press Autofill again',
    LEASE_INVALID: 'This one wasn’t filled for you this time. Please fill it on the page',
    LEASE_EXPIRED: 'This application has expired. Please start again from Career Companion',
    JOURNAL_UNAVAILABLE: 'Left as is this time (we couldn’t make sure you could undo it). Please fill it on the page',
    STILL_EMPTY: 'This one is still empty. Please fill it in on the page',
  },

  workAuth: {
    noRecord: (region) => `No work authorization for ${region} in your profile`,
    defaulted: (region, sponsorship) =>
      `No work authorization for ${region} in your profile; answered “${sponsorship ? 'No sponsorship needed' : 'Yes'}” by default. Please review before you submit`,
  },

  unsavedEntry: {
    question: (collection, number) => `${collection === 'experience' ? 'Work experience' : 'Education'} #${number}`,
    range: (collection, from, to) => `${collection === 'experience' ? 'Work experience' : 'Education'} #${from === to ? from : `${from}–${to}`}`,
    reason: (saveLabel) => `Filled into the site’s editor; click “${saveLabel === '' ? 'Save' : saveLabel}” to keep it`,
    missing: (labels, saveLabel) =>
      `${labels.length === 0 ? 'Couldn’t fill this entry into the editor' : `Still missing ${labels.map((label) => `“${label}”`).join(', ')}`}; fill it in, then click “${saveLabel === '' ? 'Save' : saveLabel}”`,
    rejected: (saveLabel) => `The site didn’t accept this entry. Check the messages in the editor, fix them, then click “${saveLabel === '' ? 'Save' : saveLabel}”`,
    saved: (saveLabel) => `Saved with “${saveLabel === '' ? 'Save' : saveLabel}” for you`,
    notAdded: {
      afterUnsaved: 'Not added to the site yet: save the entry before it first, then press Autofill again',
      editorOpen: 'Not added to the site yet: this section has an unsaved entry open on the site. Deal with it, then press Autofill again',
      again: 'Not added to the site yet: press Autofill again to keep adding',
    },
  },

  notAdded: {
    late: 'Ran out of search time on this page',
    list: (groups) => `Not added: ${groups.map((group) => `${group.values.join(', ')} (${group.why})`).join('; ')}`,
  },

  outcomes: {
    NO_MISSION_FOR_PAGE: 'This job can’t be autofilled right now. Please reload the page and try again.',
    RUNTIME_UNRESOLVED: 'This page can’t be filled right now. Please reload it in a moment and try again.',
    RUN_FAILED: 'Something went wrong partway, so filling didn’t finish. Please reload the page and try again.',
    POLICY_DISABLED: 'This version of the extension can’t fill this page right now. Try again later, or update the extension.',
    DETACHED: 'The page just changed. Please reload it and press Autofill again.',
    INTENT_REJECTED: 'This application has expired. Please go back to Career Companion and start again.',
    LOGIN_REQUIRED: 'Your sign-in expired. Sign in to Career Companion again and try once more.',
    NOTHING_FILLED: 'Nothing on this page could be filled from your profile. Please answer the rest yourself.',
    NO_FORM_FOUND: 'Can’t recognize an application form on this page yet. Please reload and try again.',
    CREDENTIAL_PAGE: 'This page needs you to sign in first. Sign in on the site, then press “Autofill”.',
    RULES_MATCHED_NOTHING: 'Can’t recognize an application form on this page yet. Please reload and try again.',
    PATH_NOT_APPLY: 'This page isn’t an application form. Open the application page, then press Autofill.',
    ROOT_NOT_FOUND: 'Can’t recognize an application form on this page yet. Please reload and try again.',
    APPLY_FORM_NOT_OPENED: 'The application form on this page isn’t open yet: first click the site’s apply button (such as “Apply for This Job”), then press Autofill once the form appears.',
    IN_EMBEDDED_FRAME: 'The application form is embedded further down this page and has its own Career Companion button. Scroll to the form and press “Autofill” there.',
    NO_KEYED_FIELD: 'We can’t fill any of the questions on this page yet. Please fill them in on the site.',
    NOT_SEALABLE: 'The page was still changing, so nothing was filled. Please reload the page and try again.',
    SCAN_NOT_SEALABLE: 'The page was still changing, so nothing was filled. Please reload the page and try again.',
    NO_AUTHORIZED_FIELD: 'The questions on this page need to be filled in by you on the site.',
    GESTURE_UNTRUSTED: 'Couldn’t start. Please press Autofill again.',
    GESTURE_FOREIGN: 'Couldn’t start. Please press Autofill again.',
    CAPABILITY_DISABLED: 'For now, the questions on this page need to be filled in by you.',
    NOT_FOUND: 'The page hasn’t finished loading. Please reload and try again.',
    PLAN_STALE: 'The page just changed. Please press Autofill again.',
    LEASE_INVALID: 'The page just changed. Please press Autofill again.',
    TIMED_OUT: 'Filling isn’t confirmed yet. Please check the site.',
    WORKER_UNREACHABLE: 'The extension isn’t responding. Please reload the page and try again.',
    STOPPED: 'Filling stopped. Please check what was filled on the site.',
    AUTHORITY_UNAVAILABLE: 'Can’t reach Career Companion right now, so filling didn’t start. Please reload the page in a moment and try again.',
    RUN_UNAVAILABLE: 'Autofill isn’t available right now. Please reload the page in a moment and try again.',
    PROFILE_UNAVAILABLE: 'Can’t read your profile right now, so this page wasn’t filled. Try again later, or check your profile in Career Companion first.',
    PROFILE_TIMEOUT: 'Career Companion took too long to send your profile, so this page wasn’t filled. Press “Autofill” again in a moment.',
    PROFILE_BUSY: 'Your profile is being saved right now (maybe you just edited it in Career Companion), so this page isn’t filled yet. Wait a few seconds, then press “Autofill” again.',
  },

  handBack: { title: 'Some questions need you', sub: 'Please finish the remaining questions on the site.' },

  diagnosticsHints: {
    RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY: 'Résumé not attached: this version has no PDF yet (the upload isn’t a PDF, or it isn’t generated yet). Upload or generate a PDF in Career Companion, then press Autofill again.',
    RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_RESUME_VERSION_NOT_FOUND: 'Résumé not attached: your default résumé is no longer in Career Companion. Choose a new default on the résumé page.',
    RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE: 'Résumé not attached: this version isn’t ready right now (it may still be generating). Press Autofill again shortly, or pick another version in Career Companion.',
    RESUME_ATTACHMENT_NO_RESUME: 'Résumé not attached: your Career Companion account has no résumé yet. Upload or generate one on the résumé page first.',
    RESUME_ATTACHMENT_RESUME_CHOICE_REQUIRED: 'Résumé not attached: you have several résumés but no default. Choose one in “My profile”.',
    RESUME_ATTACHMENT_PLAN_TARGET_NOT_ALLOWED: 'Résumé not attached: this site can’t take a résumé from us yet. Please attach it on the page.',
    EEO_ANSWERS_FETCH_FAILED: 'Self-identification not prefilled: can’t read your saved answers right now. Please choose these yourself.',
  },
  resumeVersion: {
    RESUME_ATTACHMENT_PREPARED_FOR_JOB: 'The version you tailored for this job',
    RESUME_ATTACHMENT_DEFAULT_VERSION: 'Your default résumé',
  },

  profile: {
    groups: { personal: 'Personal', job: 'Job search', history: 'Background', settings: 'Application settings' },
    sections: {
      basic: 'Basic info', addr: 'Address', links: 'Links', auth: 'Work authorization', prefs: 'Job preferences', qa: 'Common questions',
      exp: 'Work experience', edu: 'Education', skills: 'Skills & languages', resume: 'Default résumé', consent: 'Filling on your behalf',
      eeo: 'Self-identification',
    },
    fields: {
      first: 'First name', last: 'Last name', preferred: 'Preferred name', pronouns: 'Pronouns', email: 'Email', phone: 'Phone',
      line1: 'Street address', city: 'City', region: 'State or region', postal: 'ZIP / postal code', country: 'Country',
      portfolio: 'Portfolio', website: 'Personal website',
      workAuth: 'Are you legally authorized to work in the US?', sponsor: 'Will you now or in the future need visa sponsorship?',
      over18: 'Are you at least 18 years old?',
      salary: 'Expected salary', modes: 'Work arrangements you’d accept', start: 'Earliest start date', notice: 'Notice period',
      relocate: 'Are you willing to relocate?', cities: 'Cities you’d relocate to',
      referral: 'Where do you usually find jobs like this?', summary: 'Summary',
      title: 'Job title', company: 'Company', loc: 'Location', current: 'I work here now', from: 'Start', to: 'End', desc: 'What you did',
      inSchool: 'I study here now', expectedGraduation: 'Expected graduation',
      school: 'School', degree: 'Degree', major: 'Field of study', skills: 'Skills', langs: 'Languages',
      gender: 'Gender', hispanic: 'Hispanic / Latino', race: 'Race / ethnicity (choose all that apply)', veteran: 'Protected veteran status',
      disability: 'Disability status', eeoReuse: 'Use these answers on applications',
    },
    options: {
      unset: 'Not selected', preferNotToSay: 'Prefer not to say', yes: 'Yes', no: 'No',
      authorized: 'Yes', notAuthorized: 'No', sponsorNo: 'No', sponsorYes: 'Yes', relocateYes: 'Yes', relocateNo: 'No',
      countries: { US: 'United States', CA: 'Canada', CN: 'China', GB: 'United Kingdom' },
      workModes: { REMOTE: 'Remote', HYBRID: 'Hybrid', ONSITE: 'On-site' },
      referral: { companySite: 'Company website', referral: 'Referral', jobBoard: 'Job board', other: 'Other' },
      degrees: { ASSOCIATE: 'Associate', BACHELOR: 'Bachelor’s', MASTER: 'Master’s', PHD: 'PhD' },
      periods: { year: 'per year', month: 'per month', hour: 'per hour' },
    },
    eeo: {
      woman: 'Woman', man: 'Man', decline: 'Decline',
      asian: 'Asian', white: 'White', black: 'Black / African American', nativeAmerican: 'American Indian / Alaska Native',
      pacificIslander: 'Pacific Islander', notVeteran: 'No', veteran: 'Yes', noDisability: 'No', disability: 'Yes',
      caption: 'Used only when an application asks. You can choose “Decline” for any of them.',
    },
    proficiency: { NATIVE_OR_BILINGUAL: 'Native', PROFESSIONAL: 'Fluent', CONVERSATIONAL: 'Conversational', BASIC: 'Basic' },
    // 与门户资料页 `Onboarding.form.signingConsent` 的英文逐字相同（同一个文案版本 application-signing-2026-09-28）。
    consentLabel: 'Let ArgoLand handle the terms, declarations and authorizations on application forms in my name, and sign up or sign in to job sites for me. See the Privacy Policy.',
    consentLinkText: 'Privacy Policy',
    consentScopePage: 'SIGNING_SCOPE' as DockPortalPage,
    consentScopeCta: 'See what this covers in the Privacy Policy',
    optional: 'Optional',
    cityPlaceholder: 'Type a city, then press Enter',
    tagPlaceholder: 'Type, then press Enter to add',
    langPlaceholder: 'e.g. Japanese · Basic',
    addExperience: 'Add experience',
    addEducation: 'Add education',
    discard: 'Discard changes',
    save: 'Save',
    saving: 'Saving…',
    leaveTitle: (value) => `You have ${plural(value, 'unsaved change')}`,
    leaveSub: 'Save before you leave?',
    present: 'Present',
    expected: 'expected',
    removeTag: 'Remove',
    decrease: 'Decrease',
    increase: 'Increase',
    notSet: 'Not set',
    days: (value) => plural(value, 'day'),
    countryCode: 'Country code',
    currency: 'Currency',
    payPeriod: 'Pay period',
    manageResumes: 'Manage résumés in Career Companion',
    resumesUnavailable: 'Can’t load your résumés right now.',
    noResumes: 'There’s no résumé in your account yet.',
    currentDefault: 'Default',
    resumeUpdated: (month, day) => ` · Updated ${monthName(month)} ${day}`,
    removeEntry: 'Remove this entry',
    newExperience: 'New experience',
    newEducation: 'New education',
    openToFill: 'Click to fill in',
    sectionUnavailable: 'Can’t load this right now. You can change it on the Career Companion website.',
    entryCount: (value) => plural(value, 'entry', 'entries'),
    on: 'On',
    off: 'Off',
    statusSaving: 'Saving…',
    statusDirty: (value) => plural(value, 'unsaved change'),
    statusSaved: 'Saved',
    statusClean: 'All changes saved',
    statusChecking: 'Updating…',
    statusStale: (minutes: number) => (minutes < 1 ? 'Couldn’t update. Showing what we read just now' : `Couldn’t update. Showing what we read ${minutes} min ago`),
    retry: 'Retry',
    sectionLoading: 'Loading…',
    hudSaved: 'Saved',
    hudSaving: 'Saving',
    loading: 'Loading your profile…',
    loginExpired: 'Your sign-in expired. Sign in again, then reopen this page.',
    unavailable: 'Can’t load your profile right now. Please try again later.',
    slow: 'Career Companion took too long to send your profile. Please try again in a moment.',
    busy: 'Your profile is being saved elsewhere. Wait a few seconds, then open this page again.',
    unavailableCode: (code: string) => `If you contact us, include: ${code}`,
    editInPortal: 'Edit in Career Companion',
    needsFixing: (value) => `${plural(value, 'field')} ${needVerb(value)} fixing`,
    saveFailed: 'Can’t save right now. Please try again later.',
    saveStale: 'Your profile keeps changing elsewhere. Your changes are still here; save again in a moment.',
    saveStaleUnread: 'Your profile was just changed elsewhere and we can’t load the latest version right now. Your changes are still here; save again in a moment.',
    saveMerged: 'Your profile was just changed elsewhere. We put your changes on the latest version and saved.',
    saveSessionChanged: 'You’re now signed in to a different account, so these changes weren’t saved.',
    conflict: {
      title: 'These were also changed elsewhere',
      sub: 'Pick which version to keep for each, then save.',
      mine: (value: string) => `Yours: ${value}`,
      theirs: (value: string) => `Elsewhere: ${value}`,
      save: 'Save',
      cancel: 'Not now',
      empty: '(empty)',
      removed: '(remove this entry)',
      joiner: ', ',
    },
    saveLogin: 'Your sign-in expired. Sign in to Career Companion again, then save.',
    saveInvalid: 'Something is in the wrong format, so it wasn’t saved. Please check your phone, email and links.',
    saveTimeout: 'Career Companion took too long to answer, so we can’t tell whether it saved. Your changes are still here; press Save again in a moment.',
    saveBusy: 'Your profile is being saved elsewhere. Your changes are still here; wait a few seconds, then press Save again.',
    errors: {
      first: 'Enter your first name.',
      last: 'Enter your last name.',
      email: 'That email doesn’t look right.',
      phone: 'That phone number looks incomplete.',
      salary: 'Numbers only, e.g. 170000.',
      url: 'That link looks incomplete, e.g. linkedin.com/in/your-name.',
      title: 'Enter a job title.',
      company: 'Enter a company.',
      school: 'Enter a school.',
    },
  },
};

/** 整棵冻结（只冻对象，函数照旧）。 */
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const ZH: DockCopy = /* @__PURE__ */ deepFreeze(zh);
const EN: DockCopy = /* @__PURE__ */ deepFreeze(en);

/** 这一种界面语言的那一套；不传就是中文（旧调用方与测试照旧）。 */
export function dockCopy(locale: DockLocale = 'zh'): DockCopy {
  return locale === 'en' ? EN : ZH;
}

/** 中文那一套。 */
export const COPY: DockCopy = ZH;

/** 连不上的那一类：云朵图标，「暂时连不上 ArgoLand」。 */
export const NETWORK_CODES: ReadonlySet<string> = new Set([
  'AUTHORITY_UNAVAILABLE', 'RUN_UNAVAILABLE', 'PROFILE_UNAVAILABLE',
]);
