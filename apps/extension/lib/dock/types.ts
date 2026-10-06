import type { SignOnBehalfKind } from '@edaix/apply-kernel/signOnBehalf';
import type { AuditView } from '@edaix/apply-kernel/audit';
import type { AutofillAffordance } from '../../product-panel/affordance';
import type { AuditControlHandlers } from '../auditControls';
import type { ProfileDirectoryClient } from '../profileDirectoryClient';
import type { DockProfileEditorPorts } from './profileEditorPorts';
import type { AiBadgePosition, AiEdgeStyle } from './aiField';
import type { DockLocale } from './copy';
import type { DockErrorCode, DockPlainCode } from '../dockDiagnostic';

/**
 * 浮层对外的形状（2026-09-23 按设计交接 `ArgoAI Autofill.dc.html` 重做）。
 *
 * 调用方（两个内容脚本）只认这里的类型与 `lib/autofillDock.ts` 的出口；浮层内部怎么画
 * 是 `lib/dock/` 自己的事。
 */

export type AutofillDockFace = AutofillAffordance['kind'];
export type AutofillDockEntry = 'AUTOFILL_INFORMATION' | 'RESUME' | 'COVER_LETTER';
/** 面板此刻在哪一幕：主界面（填写前、填写中、填完都在这一幕里变形），或宽版的「我的资料」。 */
export type DockScene = 'HOME' | 'AUTOFILL' | 'PROFILE';
export type DockRunState = 'IDLE' | 'PREPARING' | 'RUNNING' | 'SETTLED' | 'STOPPED';
/**
 * 一轮走到哪一步。前六个也是 worker 在 mission 那条路上报来的（`parseDockRunStep` 只收这六个）。
 *
 * `AI_DRAFTING`（2026-09-24，只由这一页自己的手势路说）：规则那几遍写完了，AI 代答还在起草——这一轮还没完
 * （负责人：「ai 如果在启用的话，就代表正在填写，那个黑色的进度框应该还显示着」）。这一步里收到的终局单子与审计
 * 只换进度条，进度卡留着、写明 AI 在填；调用方在 AI 有了结局之后说 `finishRun` / `reportBlocked` 才收尾。
 */
export type DockRunStep = 'VERIFYING_INTENT' | 'SCANNING' | 'PLANNING' | 'FILLING' | 'VERIFYING' | 'DONE' | 'AI_DRAFTING';
/**
 * 一栏在这一轮里的样子。`WRITING` 正在写；`WRITTEN` 值已经在网页上、还在等网站确认；
 * `CONFIRMED` 回读确认过。
 */
export type DockRowState = 'PENDING' | 'WRITING' | 'WRITTEN' | 'CONFIRMED' | 'UNVERIFIED' | 'PRESERVED' | 'MANUAL' | 'FAILED';
export type DockPortalPage = 'CONNECT' | 'PROFILE' | 'APPLICATIONS' | 'PRICING' | 'SIGNING_SCOPE' | 'SIGNING_SCOPE_ZH';

/**
 * 用户按了「继续到下一页」之后，宿主那边怎么样了。只有这几种说法，都由调用方判：浮层从不碰宿主的节点。
 */
export type DockAdvanceOutcome =
  /** 翻过去了，但这一次不接着填（凭证剩的时间不够）。 */
  | 'ADVANCED'
  /** 翻过去了，下一页已经在接着填。 */
  | 'ADVANCED_FILLING'
  /** 按了，宿主没翻——多半是有必填没过它自己的校验。 */
  | 'NOT_ADVANCED'
  /** 那一颗按钮此刻不在了、不再唯一、或开关没开，所以没按。 */
  | 'UNAVAILABLE'
  /** 这一次点击证明不了来自我们浮层里的真人，所以没按。 */
  | 'UNTRUSTED';

/**
 * 连填（2026-09-28 负责人决定：按一下「自动填写」，一页一页填到检查页，停在那里等他按「提交」）为什么停下了。
 *
 * `REVIEW`：填到头了——规则声明的最终提交就在这一页上、这一页没有翻页按钮了，或翻过去是一页没有表的检查页。
 * 其余都是半路停下、要他做一件事（浮层照实说是哪一件）：这一页还有必填要他处理（`NEEDS_USER`）；网站要他本人过的关卡
 * （`LOGIN` / `VERIFICATION` / `CAPTCHA`）；按了网站没翻页（`NOT_ADVANCED`）；翻页按钮此刻按不了（`UNAVAILABLE`）；
 * 翻过去这一页我们认不出要填的、后面还有（`UNKNOWN_PAGE`）；页数或时间到上限了（`PAGE_CAP` / `TIME_CAP`）；
 * 连填的开关关了（`OFF`，回到每一页一颗「继续到下一页」）；页面换了地方（`MOVED`）；他按了「停止」（`STOPPED`）。
 */
export type DockChainStop =
  | 'REVIEW'
  | 'NEEDS_USER'
  /** 网站此刻在这一页上标着错（2026-10-04）：`aria-invalid`、表里的报错提示。 */
  | 'SITE_ERRORS'
  | 'LOGIN'
  | 'VERIFICATION'
  | 'CAPTCHA'
  | 'NOT_ADVANCED'
  | 'UNAVAILABLE'
  | 'UNKNOWN_PAGE'
  | 'PAGE_CAP'
  | 'TIME_CAP'
  | 'OFF'
  | 'MOVED'
  | 'STOPPED';

/** 连填这一轮在浮层上的样子（2026-09-28）。 */
export interface DockChainState {
  /** 这一轮连填里的第几页（从 1 数）。 */
  readonly page: number;
  /** 这一轮最多连着填几页（到了就停，`PAGE_CAP` 那句话要说数）。 */
  readonly maxPages: number;
  /** 网站自己说的这一步：第几步、共几步、叫什么（说不出的就是 null，浮层照旧只写「第 N 页」）。 */
  readonly site: Readonly<{ index: number | null; total: number | null; name: string | null }> | null;
  /** 这一页之前已经连着填好的页数与项数（总结用）。 */
  readonly donePages: number;
  readonly doneFields: number;
  /** 停下了：为什么。还在往下填就是 null。 */
  readonly stop: DockChainStop | null;
}

export interface DockNextStepHandlers {
  /** 宿主页上此刻那一颗能替用户按的翻页按钮上的字；没有、不唯一、或远程开关没开就是 null。 */
  readonly label: () => string | null;
  /** 用户按了「继续到下一页」。调用方必须**同步**判这一下是不是真点击，之后才能 await。 */
  readonly advance: (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAdvanceOutcome>;
}

/**
 * 用户在浮层里按了「提交」之后，宿主那边怎么样了（2026-09-23 负责人决定：插件替用户按网站的提交）。
 */
export type DockSubmitOutcome =
  /** 按了，网站跳到了确认页或出现了确认文字。 */
  | 'SUBMITTED'
  /** 按了，网站没有提交（多半是还有必填项没过它自己的校验）。 */
  | 'NOT_SUBMITTED'
  /** 按了，但等不到网站的结论。 */
  | 'UNCONFIRMED'
  /** 网站上的提交按钮此刻找不到、不唯一、或开关没开，所以没按。 */
  | 'UNAVAILABLE'
  /** 这一次点击证明不了来自我们浮层里的真人，所以没按。 */
  | 'UNTRUSTED'
  /**
   * 按了，网站没收下，而是把一个验证码发到了他的邮箱、要他填进这一页（2026-10-04，Greenhouse 的 Security code）；或者他填的
   * 验证码网站说不对、过期了。浮层不报红条，换成验证码那张卡（`codePrompt`）。
   */
  | 'CODE_REQUIRED';

export interface DockSubmitHandlers {
  /** 宿主页上此刻有没有那一颗能替用户按的提交按钮。 */
  readonly available: () => boolean;
  /**
   * 用户按了浮层里的「提交」。事件与我方 shadow root 原样交出去：调用方同步取证，然后在
   * `pressAt` 那一刻才真的去按网站的提交（信封合上的那一下），再等网站给结论。
   */
  readonly send: (event: MouseEvent, shadowRoot: ShadowRoot, pressAt: Promise<void>) => Promise<DockSubmitOutcome>;
}

/**
 * AI 代答这一轮在浮层上的样子（2026-09-23 负责人决定）。
 *
 * `DRAFTING`：题已送出去、答案还没回来（写在进度卡上，与 `AI_DRAFTING` 那一步一起说；`targets` 是送出去的那几栏——
 * 宿主控件，只在本地——这期间它们还没有结论，不列进「需要你」）；`APPLIED`：点击后 30 秒之内回来、已经写上（行交给 `update`）；
 * `READY`：回来晚了、一个字没写——摆一颗「填入 AI 答案」，那一下点击就是写入的凭证（调用方在派发当中同步取证）；
 * `USED_UP`：这个月的 AI 次数用完了（只说一句，不推销）。
 */
export type DockAiAnswersState =
  | Readonly<{ kind: 'IDLE' }>
  | Readonly<{ kind: 'DRAFTING'; count: number; targets?: readonly Element[] }>
  | Readonly<{ kind: 'APPLIED'; count: number }>
  /** `apply` 交回写成了几项（0 = 没写成）。 */
  | Readonly<{ kind: 'READY'; count: number; apply: (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<number> }>
  | Readonly<{ kind: 'USED_UP' }>;

/**
 * 求职信（2026-09-27 负责人：申请表上有求职信栏就附上为这个岗位写的一封）。`targets` 是表上认出的求职信栏（宿主控件，
 * 只在本地），这几栏的行按状态说话：
 * `WRITING`：正在写（行画成「正在写」，不列进「需要你」）；`READY`：写好了，但那一下点击已经过了 30 秒——摆一颗
 * 「附上求职信」，那一下点击就是写入的凭证（调用方在派发当中同步取证，`apply` 交回附上了没有）；`ATTACHED`：已附上；
 * `REFUSED`：这一次附不了，行上照实说为什么。
 */
export type DockCoverLetterRefusal =
  | 'NEEDS_PAGE_JOB'
  | 'JOB_TEXT_UNUSABLE'
  | 'PROFILE_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'PAYWALL_REQUIRED'
  | 'USAGE_EXHAUSTED'
  | 'TARGET_NOT_ALLOWED'
  | 'UNAVAILABLE';

export type DockCoverLetterState =
  | Readonly<{ kind: 'IDLE' }>
  | Readonly<{ kind: 'WRITING'; targets: readonly Element[] }>
  | Readonly<{ kind: 'READY'; targets: readonly Element[]; apply: (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<boolean> }>
  | Readonly<{ kind: 'ATTACHED' }>
  | Readonly<{ kind: 'REFUSED'; code: DockCoverLetterRefusal; targets: readonly Element[] }>;

/** 「用 AI 写 / AI 改写」卡片里按「生成」之后怎么样了（2026-09-24）。 */
export type DockAiGenerateOutcome =
  /** 写进那一栏了（行交给 `update`）。 */
  | Readonly<{ kind: 'WRITTEN' }>
  /** 资料里没有足够的事实：什么都没写。 */
  | Readonly<{ kind: 'NOTHING_TO_WRITE' }>
  | Readonly<{ kind: 'USED_UP' }>
  /** 生成花的时间超过了那一下点击的有效期：写好了但没写进去，要再点一下「填入」（新的凭证）。 */
  | Readonly<{ kind: 'EXPIRED'; confirm: (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockAiGenerateOutcome> }>
  | Readonly<{ kind: 'FAILED'; reason: 'UNAVAILABLE' | 'LOGIN' | 'CHANGED' | 'PAGE_CHANGED' | 'UNTRUSTED' | 'TOO_LONG' | 'SWITCHED_OFF' | 'CANCELLED' }>;

/** 这个月的 AI 次数（会员不限）。 */
export interface DockAiQuota {
  readonly unlimited: boolean;
  readonly remaining: number | null;
  /** 次数哪天恢复（ISO 时间；会员是 null）。 */
  readonly resetsAt?: string | null;
}

/** 网页上那几栏旁边的「用 AI 写 / AI 改写」（2026-09-24）。 */
export interface DockAiTools {
  /** 摆小片的那几栏（宿主控件，只在本地）。 */
  readonly targets: readonly Element[];
  /**
   * 按「生成」。调用方必须**同步**在这一下派发当中取证，之后才去问、才写；`wanted()` 在写之前再问一次
   * 用户是不是已经关了卡片（关了就不写）。
   */
  readonly generate: (
    target: Element,
    instruction: string,
    event: MouseEvent,
    shadowRoot: ShadowRoot,
    wanted: () => boolean,
  ) => Promise<DockAiGenerateOutcome>;
  /** 这个月还能用几次；取不到就是 null（卡片上不写那一行）。 */
  readonly quota: () => Promise<DockAiQuota | null>;
}

/** AI 代答的开关（缺省开；按人存在插件本地）。 */
export interface DockAiSwitch {
  readonly load: () => Promise<boolean | null>;
  /** 存成功返回存下的值；存不下返回 null。 */
  readonly save: (enabled: boolean) => Promise<boolean | null>;
}

/**
 * 招聘网站账号（2026-09-28，负责人：像 Jobright 那样替用户在 Workday／iCIMS 上注册、登录）。
 *
 * 这一页上认出了规则声明的账号墙：主按钮写成「注册并自动填写」或「登录并自动填写」；`site` 是浮层上怎么称呼这一家
 * （「NVIDIA 的 Workday」）。
 */
export type DockAccountWall = Readonly<{ action: 'REGISTER' | 'SIGN_IN'; site: string }>;

/** 替他在账号墙上做的那几步，进度卡上照实说（前五种），做成了的记一句（后四种）。 */
export type DockAccountStatus =
  | Readonly<{ kind: 'PREPARING' | 'CHOOSING' | 'REGISTERING' | 'SIGNING_IN' | 'IDENTIFYING'; site: string }>
  | Readonly<{ kind: 'REGISTERED'; site: string; email: string; generated: boolean }>
  | Readonly<{ kind: 'SIGNED_IN'; site: string; email: string }>
  | Readonly<{ kind: 'ACCOUNT_EXISTS'; site: string }>
  | Readonly<{ kind: 'TERMS_ACCEPTED'; site: string }>;

/** 网站发来的那一封邮件长什么样（规则里的说法，只给人看；插件不读邮件）。 */
export interface DockMailHint {
  /** 发件地址（至少一个）。 */
  readonly from: readonly string[];
  /** 标题的开头；说不准是 null。 */
  readonly subject: string | null;
}

/**
 * 网站要他把邮件里的验证码填进这一页（2026-10-04，负责人：验证码第 1 步）。浮层一张卡说清：发生了什么、去哪个收件箱找
 * 哪一封、在卡上的框里输或粘贴；按「填进网站」写进规则声明的那一格或那几格，然后告诉他下一步。插件不读邮件，也不因为
 * 填了验证码就替他提交。
 */
export interface DockCodePrompt {
  /** 浮层上怎么称呼这一家（「Discord 的 Greenhouse」）。 */
  readonly site: string;
  /** 网站说发到了哪个邮箱（只在本机浮层上显示）；读不出是 null（卡上改说「你申请时填的邮箱」）。 */
  readonly recipient: string | null;
  readonly mail: DockMailHint;
  /** 验证码几位、由什么组成。 */
  readonly length: number;
  readonly charset: 'DIGITS' | 'ALPHANUMERIC';
  /** 填好之后他要做的那一步：再按一次「提交」，或者按网站上的验证钮。插件都不替他按。 */
  readonly next: 'RESUBMIT' | 'VERIFY';
  /** 网站此刻说验证码怎么了；没说是 null。`OTHER`：说了，但对不上认得的哪一种。 */
  readonly error: 'WRONG' | 'EXPIRED' | 'TOO_MANY' | 'OTHER' | null;
  /** 网站那一句原话（只在本机浮层上显示）；没说是 null。 */
  readonly siteSays: string | null;
  /** 那几格此刻已经是一串完整的验证码（我们填的，或他在网站上填的）。 */
  readonly filled: boolean;
}

/** 卡上按「填进网站」之后怎么样了。 */
export type DockCodeOutcome =
  /** 写上了。 */
  | 'FILLED'
  /** 位数或字符对不上，一格都没碰。 */
  | 'FORMAT'
  /** 网站此刻不在要验证码了（或者那几格换了）。 */
  | 'GONE'
  /** 写策略没开（远程开关）、或拿不到这一页的授权：请他直接在网站上输。 */
  | 'OFF'
  /** 这一下证明不了来自我们浮层里的真人。 */
  | 'UNTRUSTED'
  /** 写了没写上（网站改回去了、那一格写不了）。 */
  | 'FAILED';

export interface DockCodeHandlers {
  /**
   * 他在卡上按了「填进网站」，`code` 是他在卡上那一格里输或粘贴的。调用方必须在点击派发当中**同步**取证，之后才能 await；
   * 写完不提交。
   */
  readonly enter: (code: string, event: MouseEvent, shadowRoot: ShadowRoot) => Promise<DockCodeOutcome>;
}

/**
 * 账号墙上停下来要他做的那一件事。`SITE_PASSWORD`：这一家早有账号、密码和我们存的不一样——请他在浮层里输一次这一家的
 * 密码（只存在这台电脑上），或者去网站上重设；`VERIFY_EMAIL`：去邮箱点一下验证链接，回到这一页我们接着登录。别的都是
 * 一句话加一颗按钮（打开资料页、打开「招聘网站账号」、再试一次）。
 */
export type DockAccountPrompt =
  | Readonly<{ kind: 'SITE_PASSWORD'; site: string; email: string; retry: boolean }>
  /** `mail`：这一家的验证邮件从哪儿来（规则里写了才有，2026-10-04）。 */
  | Readonly<{ kind: 'VERIFY_EMAIL'; site: string; email: string; mail?: DockMailHint }>
  | Readonly<{
      kind:
        | 'CONSENT'
        | 'OFF'
        | 'NO_EMAIL'
        | 'UNAVAILABLE'
        | 'CAPTCHA'
        | 'VERIFICATION'
        | 'BLOCKED'
        | 'REJECTED'
        | 'NO_RESPONSE'
        | 'TERMS_NEED_USER'
        | 'EXPIRED'
        | 'FAILED'
        | 'CONTINUE_BY_HAND';
      site: string;
    }>;

/** 账户菜单「招聘网站账号」那一块的样子（没有任何密码：密码只在他按「显示」「复制」时现取）。 */
export interface DockAccountSettings {
  /** 他改过的注册邮箱；null = 用资料里的邮箱。 */
  readonly email: string | null;
  /** 资料里的邮箱（读不到是 null）。 */
  readonly defaultEmail: string | null;
  /** 共用的那一条密码有没有（没有 = 第一次替他注册时生成）。 */
  readonly hasPassword: boolean;
  /** 几家网站用了自己的密码。 */
  readonly sites: number;
}

export interface DockAccountHandlers {
  /** 他在浮层里输了这一家的密码、按了「用这个密码登录」。调用方必须在点击派发当中同步取证。 */
  readonly onSitePassword: (password: string, event: MouseEvent, shadowRoot: ShadowRoot) => void;
  /** 他按了「我已验证，继续」（邮箱验证之后）。调用方必须同步取证。 */
  readonly onResume: (event: MouseEvent, shadowRoot: ShadowRoot) => void;
  readonly load: () => Promise<DockAccountSettings | null>;
  /** 共用密码的明文（他按「显示」「复制」时现取；没有是 null）。 */
  readonly reveal: () => Promise<string | null>;
  /** 改注册邮箱（null = 改回用资料里的）。`INVALID` = 形状不对。 */
  readonly setEmail: (email: string | null) => Promise<DockAccountSettings | 'INVALID' | null>;
  /** 改共用密码。`WEAK` = 不合要求。 */
  readonly setPassword: (password: string) => Promise<DockAccountSettings | 'WEAK' | null>;
}

/** 一页的运行为什么作废。 */
export type DockRetireReason = 'ADVANCED' | 'ADVANCED_EMPTY' | 'PAGE_CHANGED';

/** The worker's last word on a run the dock asked for. */
export type DockRunOutcome =
  | Readonly<{ started: false; code: string }>
  | Readonly<{ started: true; outcome: 'FILLED' | 'STOPPED' | 'NEEDS_USER_INPUT' | 'TIMED_OUT'; code?: string }>;

export type DockBlockedAction = Readonly<{
  kind: 'OPEN_APPLICATION_FORM';
  onClick: () => void;
}>;

/** 岗位卡上的两行：职位名、公司。只是名字——不是表单数据。 */
export interface DockJobCard {
  readonly title: string;
  readonly company: string;
  /**
   * 首页展开成摘要卡要的那几样（2026-09-24）：只有读到了 JobPosting（这一页，或同站点的职位详情页）才有；
   * 没有就照旧是一行岗位名加「公司 · 厂商」。
   */
  readonly facts?: DockJobFacts;
}

export interface DockJobSalary {
  readonly min: number;
  readonly max: number;
  /** ISO 4217，三个大写字母。 */
  readonly currency: string;
  readonly unit: 'YEAR' | 'MONTH' | 'WEEK' | 'DAY' | 'HOUR' | null;
}

/** 匹配要点的一行：✓ 长处 / · 差距。 */
export interface DockJobHighlight {
  readonly tone: 'strength' | 'gap';
  readonly text: string;
}

/**
 * 首页岗位摘要卡上的几样，全部来自页面公开的 JobPosting。读不出的一项不给，卡片上就不摆。
 * 简介只是第一段像样的正文（纯文本）：只进面板，不进日志、遥测与任何意图（RULE-GLOBAL-DATA-L1）。
 */
export interface DockJobFacts {
  readonly location?: string;
  readonly workMode?: 'REMOTE' | 'HYBRID' | 'ONSITE' | null;
  readonly employment?: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERNSHIP' | null;
  readonly salary?: DockJobSalary | null;
  readonly description?: string;
  /** `YYYY-MM-DD`。 */
  readonly postedAt?: string | null;
  /** 「查看完整岗位详情」开的那一页（申请页地址去掉 /apply 或 /application）；算不出就不摆这个链接。 */
  readonly detailUrl?: string | null;
  /**
   * 匹配要点。数据源等负责人定（2026-09-24：先不显示）——眼下没有人给，给了空的也什么都不画。
   * 这里绝不自己生成。
   */
  readonly highlights?: readonly DockJobHighlight[];
}

/** 账户头像与菜单上的名字、邮箱（用户自己的资料，只在浮层里显示）。 */
export interface DockAccount {
  readonly name: string;
  readonly email: string;
}

export interface AutofillDockHandlers {
  /**
   * A trusted click on Autofill. Never fired for a synthetic event.
   *
   * 带上那一次事件与我方 shadow root：无 mission 那条路的信任根就是它们两个。
   */
  readonly onAutofill: (event: MouseEvent, shadowRoot: ShadowRoot) => void;
  readonly onOpenEntry: (target: 'AUTOFILL_INFORMATION' | 'RESUME' | 'COVER_LETTER' | 'CURRENT_JOB') => void;
  /** 用户的 Profile V2；没有它资料页就照实说打不开，不摆一张空表。 */
  readonly directory?: Pick<ProfileDirectoryClient, 'profileV2' | 'saveProfileV2'>;
  /** 资料编辑器除 Profile V2 之外还要的几样（自我认同、代填授权、默认简历）。 */
  readonly profilePorts?: DockProfileEditorPorts;
  /** 挂在子帧里（公司站点上官方嵌入的 ATS iframe）。 */
  readonly embeddedFrame?: boolean;
  /**
   * 浮层说哪一种话（2026-09-25）：调用方按浏览器的界面语言挑（`browserDockLocale`）。不传就是中文——
   * 测试与浮层预览工具照旧；产品里的内容脚本总会传。
   */
  readonly locale?: DockLocale;
  /**
   * 账户菜单里的「语言」（2026-09-27）：用户点了另一种语言，调用方记下来并换一套文案重挂浮层。没接就没有这一行。
   * 只在主页（没有在填、也没有这一轮的结果）上能换：重挂浮层会把正在跑的一轮与结果清单一起丢掉。
   */
  readonly onChangeLocale?: (locale: DockLocale) => void;
  /**
   * 网页上 AI 标记的样式覆盖：边（`AI_EDGE_STYLE`）与有字多行框的小片位置（`AI_BADGE_POSITION`）。只给测试与浮层
   * 预览工具用；产品里不传，照负责人定的两个常量。
   */
  readonly aiMarkStyle?: Readonly<{ edge?: AiEdgeStyle; badge?: AiBadgePosition }>;
  /** Where the launcher sat last time, as a share of the viewport height. */
  readonly launcherTopRatio?: number;
  /** Called once a drag settles, so the caller can remember the new position. */
  readonly onMoveLauncher?: (ratio: number) => void;
  /** 保留给旧调用方；岗位卡改由 `jobCard` 供数。 */
  readonly job?: AutofillDockJob | null;
  /** 这一页的岗位名与公司（调用方从页面的公开标准里读出来）。读不出就是 null。 */
  readonly jobCard?: () => DockJobCard | null;
  /** 「你的资料」那几行的副标题：用户账号里已有的东西，不是宿主表单上的值。 */
  readonly entrySummary?: (target: AutofillDockEntry) => string | null;
  /** 账户头像与菜单上的名字、邮箱。 */
  readonly account?: () => DockAccount | null;
  /** Take the user to the portal. The dock names a page; the worker owns the URL. */
  readonly onOpenPortal?: (page: DockPortalPage) => void;
  /** 最近的稳定诊断码（只有码，没有值），放进失败卡的「技术细节」。 */
  readonly recentDiagnostics?: () => Promise<readonly string[]>;
  /** 浮层这一侧从前吞掉的错（复制没成、开关读不到）：交一个闭集里的稳定码（2026-10-04「吞掉的错」）。 */
  readonly onDiagnostic?: (code: DockPlainCode) => void;
  /**
   * 浮层这一侧接住的异常（按钮的处理抛了、资料保存抛了）：交一个闭集里的稳定码与那个错（调用方只取它闭集里的类名，
   * lib/dockDiagnostic.ts）。2026-10-04 体检 11-2。
   */
  readonly onError?: (code: DockErrorCode, error: unknown) => void;
  /** 退出登录。浮层只发一个意图；凭据与作废在 worker。没接这个处理器就没有这一项。 */
  readonly onSignOut?: () => void;
  /** 多页申请的「继续到下一页」。没接就没有这颗按钮。 */
  readonly nextStep?: DockNextStepHandlers;
  /**
   * 在浮层里提交（替用户按网站的提交）。没接就只提示去网站上点。
   * 名字刻意不叫 submit：随包 JS 里不许出现 `.submit(`（RULE-EXT-NEVER-SUBMIT 的字节闸）。
   */
  readonly submission?: DockSubmitHandlers;
  /** 进度卡上的「停止」。没接就没有这颗按钮（mission 那条路在 worker 里跑，停不了）。 */
  readonly onStop?: () => void;
  /**
   * 这个浮层被拆了（换脸、让给助手、让给顶层帧、换语言重挂）：它驱动的那一轮随之收场（连填，2026-09-28）。只叫一次。
   */
  readonly onDismissed?: () => void;
  /** 「暂时没法判断这一页」那张脸上的「重新检查」。 */
  readonly onRecheck?: () => void;
  /** The vendor this page was recognised as, for the page card. Names only. */
  readonly vendorLabel?: string;
  /** The host this page is on, for the page card. */
  readonly hostname?: string;
  /**
   * Open the panel as soon as it mounts（用平常那段打开动画：先按「收着」画一帧再打开）。不挪焦点（2026-10-03 体检 P0-2）：
   * 这一下不是他点的，他可能正在网页上打字。
   */
  readonly autoOpen?: boolean;
  /**
   * 网站自己的主要操作按钮（提交、申请、下一步；内核的 `sitePrimaryActions`）。自动打开之前问一次：面板要占的那一条里有它们，
   * 就收窄面板让开（至少留 320 像素宽），让不开就先不自动打开（2026-10-04，bench-1003：BambooHR 的「Apply for This Job」、
   * Greenhouse 的「Submit application」、Workday 的「Save and Continue」被盖住）。用户自己点开的照常是原来的宽。
   */
  readonly siteActions?: () => readonly Element[];
  /**
   * 用户自己收起了面板（页头的「收起」或 Esc；程序里的 closePanel 不算）。调用方据此在这一页、这个站点
   * 30 分钟之内不再自动打开（`lib/dockAutoOpen.ts`）。
   */
  readonly onCollapse?: () => void;
  /** 用户点右边那颗收起按钮打开了面板（他最近一次的意思是「要」）。 */
  readonly onLauncherOpen?: () => void;
  /** 面板打开了。调用方用它提前把这一轮要用的东西取来。 */
  readonly onPanelOpen?: () => void;
  /** 插件版本号，写进失败卡的「技术细节」。 */
  readonly extensionVersion?: string;
  /**
   * 刚在上一页替用户提交成功、网站跳到了确认页（worker 记着这个标签页）：挂上就打开面板，把信封
   * 那一段收尾（对勾、「提交成功」）播完。
   */
  readonly justSubmitted?: boolean;
  /** 旧的「生成申请卡片」入口（新设计里没有这一步）；留着只为调用方编译得过。 */
  readonly onAddJob?: () => void;
  /** 同上。 */
  readonly onLoadApplyResumes?: () => void;
  /** AI 代答的开关（账户菜单里那一项）。没接就没有这一项。 */
  readonly aiAnswers?: DockAiSwitch;
  /**
   * 「记住我的回答」（账户菜单里那一项，2026-09-28 起默认开）：开着，他在浮层里答的会记下来、下次自动填。
   * 没接就没有这一项。
   */
  readonly answerMemory?: DockAiSwitch;
  /** 代填授权的一键同意（2026-09-28）：没同意当前版本、也没撤回过的人，一张卡请他同意。没接就没有这张卡。 */
  readonly signingReconsent?: DockSigningReconsent;
  /** 招聘网站账号（2026-09-28）：账户菜单里那一块与账号墙上的两种输入。没接就都没有。 */
  readonly accountAccess?: DockAccountHandlers;
  /** 网站要邮件里的验证码时，卡上那一格的「填进网站」（2026-10-04）。没接就只说去网站上输。 */
  readonly verificationCode?: DockCodeHandlers;
}

/**
 * 代填授权的一键同意（2026-09-28）。卡上照登那一句（与门户资料页那一格逐字相同，「隐私政策」点开写明范围的那一节）；
 * 「同意」把这一版记到 argoland，「暂不」什么都不改（只是这一版不再请他）。
 */
export interface DockSigningReconsent {
  /** 此刻要不要请他同意：服务端要的正是这版插件显示的那一版、他没同意、没撤回过、在这台电脑上也没说过「暂不」。 */
  readonly offered: () => boolean;
  /**
   * 他在卡上按了「同意新版本」。那一下是我们关着的 shadow 里的真实点击（调用方当场再验一次），存成了答 true；
   * 没存上答 false（卡片留着，浮层照实说没存上）。
   */
  readonly accept: (event: MouseEvent, shadowRoot: ShadowRoot) => Promise<boolean>;
  /** 他按了「暂不」：什么都不改，这一版不再请他（调用方记在本机）。 */
  readonly decline: () => void;
}

/** Progress for one field. Counts and labels; a value only when it was ours to write. */
export interface AutofillDockFieldRow {
  readonly label: string;
  readonly required: boolean;
  /** Settled by this run. A row the run never reached is not done. */
  readonly done: boolean;
  /** What was written, shown back so the review is a real one. */
  readonly value?: string | null;
  /** Only the user may answer this one. */
  readonly needsUser?: boolean;
  /** The row's state; derived from `done`/`needsUser` when absent. */
  readonly state?: DockRowState;
  /** A stable reason code for a row that is not confirmed; never a message. */
  readonly reason?: string | null;
  /** Scroll the host field into view. Local only; never crosses a boundary. */
  readonly locate?: () => void;
  /**
   * 这一格在宿主页上的控件（只在本地）：「去那一栏」时滚过去、亮一下，并看用户是不是已经在网站上
   * 填了它（只判断有没有值）。
   */
  readonly target?: Element;
  /**
   * 这一格在这一轮的计划里（我们要写它，写没写成都算）。它在这一轮收尾那一刻的样子——我们写的值、
   * 宿主据此改成的样子、或者本来就在的内容——不是用户补的：浮层只在它之后又变了样时才记成「你已填好」。
   * 2026-09-23：后台标签页里我们写成却没能确认的五栏，从前被算成了「你补上了 5 项」。
   */
  readonly planned?: boolean;
  /**
   * 这一格是以用户的名义代填的条款同意、属实声明、签名、同意类（2026-09-24 起六类，2026-09-28 起再加第五刀的新类别），
   * 或按资料里的回答答的「能不能联系雇主」（2026-09-28）。
   */
  readonly signedOnBehalf?: SignOnBehalfKind;
  /** 工作授权／担保的答案按岗位地点推断出的国家（已本地化的国名）。 */
  readonly inferredRegion?: string;
  /**
   * 工作授权题说得出是哪一国（题目点名、或按岗位地点推断），而用户在那一国没有工作许可记录（2026-09-24，
   * 已本地化的国名）：这一题照旧不答，原因照实说是哪一国。他有别国的记录时不走这里，按默认答（下一项）。
   */
  readonly regionWithoutRecord?: string;
  /**
   * 工作授权／担保题是按默认答的（2026-09-24 负责人决定，与竞品一致：他有别国的工作许可记录、唯独没有这一国的——
   * 有权工作答「是」、要不要担保答「不需要」）：那一国（已本地化的国名）、这一题问的是不是担保。仍是我们填好的一行；
   * 浮层在值后面写明，请他提交前核对。
   */
  readonly defaultedWorkAuth?: Readonly<{ region: string; sponsorship: boolean }>;
  /**
   * 这一行不是一栏，是一段我们加了、填了、没能保存下来的经历／教育（2026-09-24，Workable 的「Update」）：
   * 第几段（从 1 数）、网站上那颗保存钮上的字、还差的那几格（宿主的标签；没有就是按了没存上）。
   * 浮层照实说还差什么、要他点「Update」。
   */
  readonly unsavedEntry?: Readonly<{ collection: 'education' | 'experience'; number: number; saveLabel: string; missing?: readonly string[] }>;
  /**
   * 这一行是一段我们替他按了保存、网站收下了的经历／教育（2026-09-24 负责人：全加全存）：算我们填好的，
   * 在「其余已填好」里写着填进去的内容与「已替你按「Update」保存」。
   */
  readonly savedEntry?: Readonly<{ collection: 'education' | 'experience'; number: number; saveLabel: string }>;
  /**
   * 资料里有、这一轮没加进网站的那几段（从 1 数，含两端）；`afterUnsaved`：前面一段没存上，这个区加不了下一段。
   */
  readonly unaddedEntries?: Readonly<{ collection: 'education' | 'experience'; from: number; to: number; afterUnsaved: boolean }>;
  /**
   * 答案是按资料推出来的（2026-09-24 起）：年满 18、「在这家公司工作过吗」；2026-10-04 起还有服过兵役吗、现在在读吗、
   * 工作年限、到办公室上班（按可接受的办公方式）、语言题。稳定码，不是句子；浮层按 `COPY.historyBasis` 写一句依据。
   */
  readonly historyBasis?:
    | 'ADULT_FROM_HISTORY'
    | 'EMPLOYER_IN_HISTORY'
    | 'EMPLOYER_NOT_IN_HISTORY'
    | 'EMPLOYER_ENDED'
    | 'NO_MILITARY_SERVICE_IN_HISTORY'
    | 'STUDENT_FROM_EDUCATION'
    | 'EXPERIENCE_YEARS_FROM_HISTORY'
    | 'WORK_MODES_IN_PROFILE'
    | 'LANGUAGES_IN_PROFILE'
    | 'TRAVEL_IN_PROFILE';
  /** 选项对不上时，用户资料里的原值（「你资料里是 …」）。 */
  readonly hint?: string;
  /**
   * 一栏收好几项的搜索式多选（Workday 的技能，2026-09-24）没加上的那几项：资料里的原值与稳定原因码
   * （`ABORTED` = 这一页的搜索时间用完了）。只在本地浮层上列出来，不进回执、不进遥测。
   */
  readonly notAdded?: readonly Readonly<{ value: string; reason: string }>[];
  /** 这是一个勾选框：填好了就写「已勾选」，不把那句同意原文再念一遍。 */
  readonly checkbox?: boolean;
  /** 这是一个附件栏（简历）。 */
  readonly attachment?: boolean;
  /** 这一格是 AI 代答写的（按用户自己的资料起草，2026-09-23）：单列一组、网页上挂标记。 */
  readonly aiAnswered?: boolean;
  /**
   * 这一栏是网站在我们附上简历之后自己从简历里读出来填的（2026-09-24）：不是我们填的，也不是用户补的。
   * 浮层照实写「网站从你的简历里读的」，不记进「你补上了」。
   */
  readonly fromResume?: boolean;
  /**
   * 这一格属于经历／教育的第几段、共几段（2026-09-28）：进度卡据此说「正在填工作经历 2/3」。只是位置，不是值。
   */
  readonly collection?: Readonly<{ kind: 'education' | 'experience'; number: number; total: number }>;
  /** 这一格是用户在浮层里当场答的（点了一个选项、或填了一句，2026-09-28）：算填好了，写明是他答的。 */
  readonly userAnswered?: boolean;
  /** 这是一道自我认同题（性别、族裔、退伍、残障……，2026-09-28）：读不到他保存的答案时，那句提示挂在这几行上。 */
  readonly selfIdentification?: boolean;
}

export interface AutofillDockProgress {
  readonly runId: string;
  readonly requiredCompleted: number;
  readonly requiredQuestions: number;
  readonly rows: readonly AutofillDockFieldRow[];
}

/** The application named at the top of the panel. Names only — never form data. */
export interface AutofillDockJob {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly match: string | null;
}

/** What the dock needs from the audit: undo lives in the ··· menu. */
export interface DockAuditHandlers extends AuditControlHandlers {
  /** Removing the only review surface retires its exact generation fail closed. */
  readonly onDismiss?: () => void;
  /** 旧面板的「补答」区；新浮层不摆这一块，留着只为调用方编译得过。 */
  readonly questions?: unknown;
  /** 「需要你」在浮层里当场答（2026-09-28）。没接（mission 那条路）就只摆「去这一栏」。 */
  readonly answers?: DockAnswers;
}

/**
 * 「需要你」里一栏能怎么当场答（2026-09-28）：单选（页面上的真实选项原文，只在本地）、一行字、一段字。多选题与说不出
 * 题面的不当场答（去那一栏）。
 */
export interface DockQuestion {
  readonly kind: 'choice' | 'text' | 'long';
  readonly options: readonly string[];
  /** 计划期替他挑好、只等他点头的那一项（按岗位地点推断的工作授权）；没有就是 null。 */
  readonly suggested: string | null;
  /**
   * 「可以联系你现在的雇主吗」（2026-09-28）：资料里有这一问、他还没答——页面上「可以」「不可以」各是哪一项。浮层摆「可以」
   * 「不可以」两颗，点了写上网页、记进资料（`preferences.contactCurrentEmployer`），不进答案记忆；以后按资料自动答。
   */
  readonly employerContact?: Readonly<{ yes: string; no: string }>;
}

/**
 * 当场答的结果：`UNTRUSTED` 这一下证明不了来自我们浮层里的真人；`ENDED` 这一轮已经结束（按了停止、翻了页、换了一轮）；
 * `CHANGED` 那一栏此刻已经有内容了（不覆盖）；`REFUSED` 别的原因没写进去。
 */
export type DockAnswerOutcome =
  /** `profile`：这一题记进了资料（能不能联系雇主那一问）没有；别的题不带。 */
  | Readonly<{ ok: true; profile?: 'SAVED' | 'NOT_SAVED' }>
  | Readonly<{ ok: false; reason: 'UNTRUSTED' | 'ENDED' | 'CHANGED' | 'REFUSED' }>;

export interface DockAnswers {
  /** 这一栏（单子上那一行的元素）能不能在浮层里当场答；不能（按规定留给本人、这一轮已经结束……）就是 null。 */
  readonly question: (target: Element) => DockQuestion | null;
  /**
   * 用户在浮层里点了一个选项、或按了「填入」：这一下原样交出去——调用方在派发当中同步取证，经内核同一条授权路写进
   * 那一栏（点击铸票、这一轮的信封、同一本撤销日志）。`remember`：写成之后记进答案记忆（资料里没有的那几题；答案记忆
   * 的总开关关着就不记，不另问）。
   */
  readonly answer: (target: Element, value: string, event: Event, shadowRoot: ShadowRoot, remember: boolean) => Promise<DockAnswerOutcome>;
}

export interface DockAuditHandle {
  readonly dismiss: () => void;
  readonly update: (view: AuditView) => void;
  readonly shadowRoot: ShadowRoot | null;
}

export interface AutofillDockHandle {
  readonly face: () => AutofillDockFace;
  /** 这张脸的完整身份：`kind:reason`。 */
  readonly faceKey: () => string;
  readonly autofillEnabled: () => boolean;
  /** For tests and for focus handling; the page never receives this node. */
  readonly autofillButton: () => HTMLButtonElement | null;
  readonly dismiss: () => void;
  /** 'ABSENT' until a run exists; otherwise whether the run is showing. */
  readonly sheetState: () => 'ABSENT' | 'AUTOFILL_EXPANDED' | 'AUTOFILL_STICKY_COLLAPSED';
  /** The summary line, or null when there is no run. */
  readonly summaryText: () => string | null;
  /** 旧的「收起／展开这一轮」；新浮层里一轮始终在主卡上，这里什么都不做。 */
  readonly toggleSheet: () => void;
  /** The rows the run is showing for one group. */
  readonly fieldRows: (group: 'required' | 'optional') => readonly AutofillDockFieldRow[];
  /** Refresh the run for the same run. */
  readonly update: (progress: AutofillDockProgress) => void;
  /** A run has started: adopt its rows and replace whatever was showing. */
  readonly beginRun: (progress: AutofillDockProgress) => void;
  readonly isOpen: () => boolean;
  /** 焦点此刻在浮层里（换脸重挂之前问：他正在浮层里操作，新浮层挂上后把焦点交回面板）。 */
  readonly hasFocus: () => boolean;
  readonly launcherButton: () => HTMLButtonElement | null;
  /** 旧的「生成申请卡片」按钮；新设计里没有，恒为 null。 */
  readonly addJobButton: () => HTMLButtonElement | null;
  /** 打开面板并把焦点放进去：只给他自己要打开的那几处用（挂上就自动打开的那一下从不挪焦点，见 `autoOpen`）。 */
  readonly openPanel: () => void;
  /** One line for what the panel could not do and why (shown as a toast). */
  readonly setNotice: (text: string) => void;
  readonly sheetFace: () => 'ABSENT' | 'WORKING' | 'COMPLETE';
  /** 「你的资料」那三行，按设计的次序。 */
  readonly entryButtons: () => readonly HTMLButtonElement[];
  /** How many required rows only the user can answer. */
  readonly attentionCount: () => number;
  readonly rowValues: (group: 'required' | 'optional') => readonly (string | null)[];
  /** 填完之后的两条路：改资料、重新填写这一页（都在 ··· 菜单里）。 */
  readonly reviewButtons: () => { edit: HTMLButtonElement | null; fill: HTMLButtonElement | null };
  readonly closePanel: () => void;
  readonly scene: () => DockScene;
  readonly runState: () => DockRunState;
  readonly beginPreparing: (label?: string) => void;
  readonly setStep: (step: DockRunStep) => void;
  readonly finishRun: (outcome: DockRunOutcome) => void;
  readonly reportBlocked: (code: string, action?: DockBlockedAction) => void;
  readonly showAudit?: (view: AuditView, handlers: DockAuditHandlers) => DockAuditHandle;
  readonly openProfile: () => void;
  readonly backHome: () => void;
  readonly profileRoot: () => HTMLElement | null;
  readonly sceneRoot: () => HTMLElement | null;
  readonly toast: (text: string) => void;
  readonly retireRun: (reason: DockRetireReason) => void;
  readonly nextStepButton: () => HTMLButtonElement | null;
  /** 主卡下面那颗主按钮（逐项处理 / 提交 / 继续到下一页），给测试用。 */
  readonly primaryButton: () => HTMLButtonElement | null;
  /** 调用方拿到了新的账户信息、简历名：重画「你的资料」与头像。 */
  readonly refreshAccount: () => void;
  /**
   * 换了一个人登录（2026-10-04）：资料编辑器里上一个人的那一份连同没存的修改一起丢掉（资料页开着就按新的人重读），
   * AI 代答、记住回答两个开关的状态也重新问。
   */
  readonly forgetUser: () => void;
  /** 他刚回到这一页（可能刚在门户里改过资料，2026-10-04）：资料页开着就在后台再对一次。 */
  readonly revalidateProfile: () => void;
  /** 调用方读到了岗位的更多信息（同站点的职位详情页回来了）：重画岗位卡。 */
  readonly refreshJob: () => void;
  /**
   * 连填（2026-09-28）：这一页是一次「自动填写」连着往下填的第几页、停没停下、为什么；null = 这一轮不连填（单页、
   * 或连填的开关没开）。连填还在往下填（`stop` 为 null）时，这一页填完不收尾：进度卡留着，等下一步（往下翻或停下）。
   */
  readonly setChain: (state: DockChainState | null) => void;
  /**
   * 连填替他按网站的下一步（没有点击）：进度卡留着、写明正在翻到下一页；结论与「继续到下一页」同一套——
   * `ADVANCED_FILLING` 接着填下一页，`NOT_ADVANCED` 出「网站没有翻页」的横幅，别的照实说。`label` 是网站那颗按钮上的字。
   */
  readonly autoAdvance: (pending: Promise<DockAdvanceOutcome>, label: string | null) => void;
  /** AI 代答这一轮走到哪了（起草中、已写上、晚了要再点一下、次数用完）。 */
  readonly setAiAnswers: (state: DockAiAnswersState) => void;
  /** 网页上那几栏旁边的「用 AI 写 / AI 改写」；null = 这一轮不摆。 */
  readonly setAiTools: (tools: DockAiTools | null) => void;
  /** 求职信这一轮走到哪了（正在写、写好了要再点一下、已附上、附不了）。 */
  readonly setCoverLetter: (state: DockCoverLetterState) => void;
  /**
   * AI 看过、却在资料里没找到依据的那几栏（宿主控件，只在本地）：「需要你」里那几行的原因照实改成
   * 「AI 在你的资料里没找到依据」；没送给 AI 的题照旧说原来的原因。
   */
  readonly setAiNoEvidence: (targets: readonly Element[]) => void;
  /**
   * 送给了 AI、这一轮却一个答案都没拿到的那几栏（那一道失败了、流断了；2026-09-24）：「需要你」里那几行的原因照实
   * 改成「AI 这次没答上这一题」；AI 看过、没找到依据的照旧说没找到依据。
   */
  readonly setAiUnanswered: (targets: readonly Element[]) => void;
  /** 第一次记住他在浮层里答的（2026-09-28）：说一句「已记住，下次自动填 · 可在菜单里关」。 */
  readonly noteRemembered: () => void;
  /** 这一页上认出了账号墙（主按钮换成「注册并自动填写」或「登录并自动填写」）；null = 没有。 */
  readonly setAccountWall: (wall: DockAccountWall | null) => void;
  /** 替他在账号墙上做到哪一步了（进度卡）；做成了的那几种另记一句。 */
  readonly accountStatus: (status: DockAccountStatus) => void;
  /** 账号墙上停下来要他做的那一件事；null 收起。 */
  readonly accountPrompt: (prompt: DockAccountPrompt | null) => void;
  /** 账号墙过去了、接着填：进度卡回到「准备中」（替他做过的那几句留在这一轮的总结里）。 */
  readonly accountContinuing: () => void;
  /**
   * 这一页和插件断了线（2026-10-03：插件更新、重载或停用之后，旧的内容脚本还在这一页上）：主卡换成「ArgoLand.AI 已更新，
   * 刷新这一页即可继续」与一颗「刷新页面」（只认他本人的点击）。还在准备的那一轮放下；正在写的一轮写完再换。不打开面板。
   */
  readonly extensionUpdated: () => void;
  /** 网站在要邮件里的验证码（2026-10-04）：换成那张卡；null 收起（网站不再要了）。 */
  readonly codePrompt: (prompt: DockCodePrompt | null) => void;
}
