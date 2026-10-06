import { isHostDenied, type ApplyPolicy } from '../policy';

/**
 * 主机级注入否决。**纯函数，不碰 DOM**——所以它能在最便宜的位置先跑一遍。
 *
 * 存在的理由：全网注入把失败模式从"填不上"换成了"浮层出现在不该出现的地方"，
 * 后者严重一个数量级且不可撤销。
 *
 * 竞品对照（2026-08-01 解包实测）：Jobright 声明 `<all_urls>` + all_frames，带 10 条
 * exclude_matches（全是追踪/验证域）；Simplify 声明全域通配 + all_frames，且**一条
 * exclude 都没有**。两家**都没有雇主后台否决**——这是我们比它们做得好的地方之一。
 */

export const HOST_VETO_REASONS = [
  /** 招聘方自己的候选人管理后台。 */
  'EMPLOYER_CONSOLE',
  /** 公共部门门户（社保、税务、签证、公立医疗）。 */
  'PUBLIC_SECTOR',
  /** 远程策略下发的否决后缀 —— 唯一的线上止血通道。 */
  'REMOTE_DENYLIST',
] as const;
export type HostVetoReason = (typeof HOST_VETO_REASONS)[number];

export type HostVetoVerdict =
  | { readonly vetoed: false }
  | { readonly vetoed: true; readonly reason: HostVetoReason };

/**
 * 雇主后台主机。
 *
 * 这些页面的表单形状与候选人申请表**一模一样**（姓名/邮箱/电话 + 简历上传），
 * 但填的是**别人**的资料：HR 在录入某个候选人时，被我们填上扩展使用者本人的信息。
 * 今天靠"只匹配精确的候选人侧主机名"侥幸避开，一扩围就会命中。
 *
 * 按**标签边界**匹配（见 `matchesSuffix`），所以 `app.greenhouse.io` 不会误伤
 * `job-boards.greenhouse.io`。
 */
const EMPLOYER_CONSOLE_HOSTS: readonly string[] = [
  'app.greenhouse.io',
  'my.greenhouse.io',
  'app2.greenhouse.io',
  'hire.lever.co',
  'app.ashbyhq.com',
  'admin.ashbyhq.com',
  'app.workable.com',
  'admin.workable.com',
  // Workday 的候选人面在 `*.myworkdayjobs.com`；下面这两个注册域是**雇主／管理**
  // 与**员工自助**面。它们的表单形状与候选人申请表几乎一样（姓名／邮箱／电话 +
  // 附件），填进去的却是别人的资料。
  'workday.com',
  'myworkday.com',
];

/**
 * 公共部门后缀。
 *
 * ⚠️ **按 TLD 写会漏掉大部分非英语国家**：`gob.mx` / `gob.es` 是 **gob** 不是 gov，
 * `go.jp` / `go.kr` 是 **go** 不是 gov。这张表永远不全，所以它不是唯一防线——
 * 真正的防线是页面级的正向证据要求。但漏掉整个语种是不可接受的。
 *
 * 刻意**不含** `.edu`：大学的职位页大量内嵌 ATS，一刀切会砍掉真实覆盖。
 * 教育域的保护走另一条路——只有厂商归属成立才允许注入（见 A2b 的正向门）。
 */
const PUBLIC_SECTOR_SUFFIXES: readonly string[] = [
  'gov',
  'mil',
  'gov.uk',
  'gov.au',
  'gov.sg',
  'gov.in',
  'gov.br',
  'gov.za',
  'gob.mx',
  'gob.es',
  'gob.ar',
  'gob.cl',
  'gouv.fr',
  'gouv.qc.ca',
  'go.jp',
  'go.kr',
  'go.id',
  'go.th',
  'gc.ca',
  'canada.ca',
  'admin.ch',
  'bund.de',
  'overheid.nl',
  'europa.eu',
  'nhs.uk',
  'gv.at',
  'gouv.be',
];

/**
 * **共域厂商**：雇主后台与候选人面在**同一个主机**上，只能靠路径分。
 *
 * 2026-08-23 实地取证逼出来的一类（50-证据库 §F.8-d）。上面那张
 * `EMPLOYER_CONSOLE_HOSTS` 是主机级的，对这两家根本表达不出来——
 * 写进去连申请页一起否决，不写就是对它们完全没有雇主后台防线：
 *
 *  · **Dover**：`app.dover.com/apply/<slug>/<uuid>` 是候选人申请表；
 *    `app.dover.com/login` 是**带密码框的登录页**。同一主机，实测。
 *  · **BambooHR**：`<租户>.bamboohr.com/careers/<id>` 是候选人 job board；
 *    同一个 `<租户>.bamboohr.com` 的其余路径是 HR／员工控制台。实测。
 *
 * ## 方向是候选人白名单，不是雇主黑名单
 *
 * 雇主后台的路径集**无界**（`/settings/**`、`/candidates/**`、`/employees/**`、
 * 明天新加的任何一条）。列黑名单等于承诺穷举一个持续增长的集合，漏一条的后果
 * 是浮层出现在 HR 的候选人编辑页上——2026-07-29 那次事故的形态。
 * 候选人面反过来是**小且已实测**的，所以这里 **deny by default**：
 * 该主机上白名单之外的一切一律判 `EMPLOYER_CONSOLE`，包括**路径未知**时。
 *
 * ## 为什么这里可以用后缀，而 `candidateHostSuffixes` 不行
 *
 * 方向相反。`vendors.ts` 那张表的后缀是**放行**用的，一宽就把雇主面圈进来；
 * 这里的后缀是**否决**用的，一宽只会否决得更多。同一个 `bamboohr.com` 后缀
 * 放在这里是保守的，放在那里是危险的。
 */
interface SharedHostRule {
  /** 精确主机名，或按标签边界匹配的后缀（见 `matchSuffix`）。 */
  readonly host: string;
  /** `true` 时按标签边界后缀匹配——用于逐租户子域的厂商。 */
  readonly matchSuffix: boolean;
  /** 候选人面路径白名单。**只放实测见过的形状**，没量过的不进。 */
  readonly candidatePaths: readonly RegExp[];
}

const SHARED_HOST_RULES: readonly SharedHostRule[] = [
  {
    // 精确主机：Dover 的候选人面与 HR 控制台都在 app.dover.com 上。
    // 用后缀会连 www.dover.com（市场页）一起否决——那不影响正确性，
    // 但精确主机更贴近实测，也让这张表读起来就是"我量到的那台"。
    host: 'app.dover.com',
    matchSuffix: false,
    // 实测形状：/apply/kubbly/885f0f71-a784-4957-a1f2-e3b6980d6ed0
    // 刻意收到整条 uuid 而不是只认 `/apply/` 前缀：后台路由不会长成这样，
    // 而放宽一格就要赌"`/apply/` 下面没有任何后台页"——那句话我没量过。
    candidatePaths: [/^\/apply\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i],
  },
  {
    // 逐租户子域：`<租户>.bamboohr.com`。厂商总入口 `app.bamboohr.com` 也在
    // 这个后缀下，且它没有 /careers——所以同一条规则顺带把它否掉了。
    host: 'bamboohr.com',
    matchSuffix: true,
    // 实测：/careers/33 是岗位页，点「Apply for This Job」原地展开申请表
    // （路径不变）。/careers 是列表页。legacy 的两条仍在流通。
    candidatePaths: [/^\/careers\/\d+\/?$/i, /^\/jobs\/(view|embed2)\.php\/?$/i],
  },
];

/** Machine-readable coupling for candidate suffixes that share an employer surface. */
export function sharedHostGuardedSuffixes(): readonly string[] {
  return SHARED_HOST_RULES.filter((rule) => rule.matchSuffix).map((rule) => rule.host);
}

/** 标签边界匹配：`nav.no` 命中 `www.nav.no`，但不命中 `notnav.no`。 */
function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export interface HostVetoInput {
  readonly hostname: string;
  /**
   * 形如 `/apply/acme/<uuid>`。**共域厂商上缺它等于否决**（见 `SHARED_HOST_RULES`）：
   * 那一刻我们对"这是申请页还是 HR 后台"一无所知，而那两者同域。
   * 非共域主机上它不参与判断，行为与加这个字段之前逐字相同。
   */
  readonly pathname?: string;
  readonly policy: ApplyPolicy;
}

export function evaluateHostVeto(input: HostVetoInput): HostVetoVerdict {
  const host = input.hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return { vetoed: false };

  // 远程否决排最前：它是运维在事故中用的，必须优先于任何本地判断，
  // 也必须在最便宜的位置就生效。
  if (isHostDenied(input.policy, host)) return { vetoed: true, reason: 'REMOTE_DENYLIST' };
  if (EMPLOYER_CONSOLE_HOSTS.some((entry) => matchesSuffix(host, entry))) {
    return { vetoed: true, reason: 'EMPLOYER_CONSOLE' };
  }
  // 共域厂商：这台机器上只有白名单里那几条路径是候选人面，其余全是后台。
  // 路径未知也走这一支——「不知道」在这里必须等于否决。
  const shared = SHARED_HOST_RULES.find((rule) =>
    rule.matchSuffix ? matchesSuffix(host, rule.host) : host === rule.host,
  );
  if (shared !== undefined) {
    const path = input.pathname ?? '';
    if (!shared.candidatePaths.some((pattern) => pattern.test(path))) {
      return { vetoed: true, reason: 'EMPLOYER_CONSOLE' };
    }
  }
  if (PUBLIC_SECTOR_SUFFIXES.some((suffix) => matchesSuffix(host, suffix))) {
    return { vetoed: true, reason: 'PUBLIC_SECTOR' };
  }
  return { vetoed: false };
}
