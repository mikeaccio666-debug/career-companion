import { APPLY_VENDORS, type ApplyVendor } from '@edaix/apply-kernel/vendors';
import { parseApplyProfileCollections, type ApplyProfileCollections } from '@edaix/apply-kernel/profileCollections';
import type { WorkAuthorizationFact } from '@edaix/apply-kernel/profileV2WorkAuthorizations';
import type { ReferralFact } from '@edaix/apply-kernel/profileV2Referrals';
import type { SexualOrientationAnswer } from '@edaix/apply-kernel/selfIdentificationAnswers';
import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * 面板问 worker 要「这次能用哪几份简历」。
 *
 * ## 为什么这也得是一条消息，而不是内容脚本自己去取
 *
 * 内容脚本活在宿主页面里，**手上不该有 token**（RULE-GLOBAL-HUMAN-AUTHORIZATION
 * 与 RULE-GLOBAL-DATA-L1）。所有需要凭据的读都在 worker 里做，页面这边只说
 * 「有人在这一页上点了」。`dockAddJobIntent` 是同一条道理，这一条照抄它的形状。
 *
 * ## 为什么和 add-job 分开
 *
 * 那一条是**写**：它让一个岗位进目录。这一条是**读**：它只取用户自己账号里已有
 * 的简历清单。合成一条消息意味着一次检查决定两种互不相干的权限，而且以后放宽
 * 其中一边时会顺手放宽另一边。
 *
 * 消息本身不带任何值：它只说事情发生在哪一页，worker 拿它和自己登记过的 sender
 * 比对。答复里回来的是用户自己账号的简历元数据（轨道名、文件名、版本号），
 * 不是宿主表单里的任何东西，也不进日志或遥测。
 */
export interface DockApplyMaterialsIntent {
  readonly kind: 'dock/apply-materials-intent';
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  /** 地址被单页应用改过时：文档加载时的路径（发信人核对用它比 sender.url）。 */
  readonly documentPathname?: string;
  /**
   * 要的是简历清单、用户自己的档案、这一页的只读授权，还是此刻代不代签（`SIGN_ON_BEHALF`，2026-10-03：填写开始那一刻现读，
   * 不跟着预取的档案走——撤回即失效）。
   */
  readonly want: 'RESUMES' | 'PROFILE' | 'DISCOVERY_AUTHORITY' | 'SIGN_ON_BEHALF';
  /**
   * 白标 B（P2-11）：主机不在厂商表里时，内容脚本按厂商自己的产物算出的「先试哪家」。
   * 只是提示——worker 只在主机表答不出时才用它，而且随后 resolveRoot 认不出就照常 null。
   */
  readonly vendorHint?: ApplyVendor;
}

const KEYS = ['kind', 'version', 'origin', 'pathname', 'want'] as const;
const OPTIONAL_KEYS = ['vendorHint'] as const;

export function parseDockApplyMaterialsIntent(value: unknown): DockApplyMaterialsIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = keysBesidesDocumentPath(value);
  // 精确键集，不是「够用就行」：多一个字段就是一种我们没约定过的形状，
  // 而这条消息会走到一次带凭据的读。可选键只有 vendorHint 一个，出现了就得是厂商清单里的名字。
  if (
    !KEYS.every((key) => keys.includes(key)) ||
    !keys.every((key) => (KEYS as readonly string[]).includes(key) || (OPTIONAL_KEYS as readonly string[]).includes(key))
  ) return null;
  const candidate = value as Record<string, unknown>;
  if ('vendorHint' in candidate && !(APPLY_VENDORS as readonly string[]).includes(candidate.vendorHint as string)) return null;
  if (
    candidate.kind !== 'dock/apply-materials-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string' ||
    (candidate.want !== 'RESUMES' && candidate.want !== 'PROFILE'
      && candidate.want !== 'DISCOVERY_AUTHORITY' && candidate.want !== 'SIGN_ON_BEHALF')
  ) return null;
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  return Object.freeze({
    kind: 'dock/apply-materials-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
    want: candidate.want,
    ...('vendorHint' in candidate ? { vendorHint: candidate.vendorHint as ApplyVendor } : {}),
  });
}

export function createDockApplyMaterialsIntent(
  origin: string,
  pathname: string,
  want: DockApplyMaterialsIntent['want'] = 'RESUMES',
  vendorHint: ApplyVendor | null = null,
): DockApplyMaterialsIntent | null {
  return parseDockApplyMaterialsIntent({
    kind: 'dock/apply-materials-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
    want,
    ...(vendorHint === null ? {} : { vendorHint }),
  });
}

/**
 * worker 的答复，已经投影成面板要画的样子。
 *
 * 只带面板真正用得上的五项。`resume-selection-options` 的原始条目还有
 * mimeType、fileSize、contentRevision、createdAt——那些是**选定之后**取附件才
 * 用得到的，让它们跨这道边界只是把更多用户资料摆进宿主页面所在的进程里。
 */
export type DockApplyMaterialsReply =
  /**
   * 用户自己已保存的扁平档案，给无 mission 那条填写路用。
   *
   * 值是 Data-L1，只进内核与面板，不进日志、遥测、回执。worker 取它只要用户的
   * bearer token——`/api/v1/agent/application-profile` 没有 JWS 验签那一关。
   *
   * `collections`（P1-8a）是同一个用户确认过的教育 / 经历 / 技能，由 worker 从 Profile V2
   * 投影成内核的集合形状后交来；worker 读不到 V2 时就没有这一项——扁平档案照常，
   * 行内格如实 NO_VALUE。
   */
  | Readonly<{
      kind: 'PROFILE';
      profile: Readonly<Record<string, string>>;
      /**
       * 这一份是替哪一次登录读的（不透明代号，lib/sessionStamp.ts；没登录是 null，2026-10-04）。按下「自动填写」那一刻拿它与
       * 当下的授权答复对一次：不是同一个人的就不用（换了账号绝不填上一个人的资料）。
       */
      session?: string | null;
      collections?: ApplyProfileCollections;
      /**
       * 此刻有效、用户确认过的工作授权记录（2026-09-21）。内核只在题目点名国家、恰好是有记录的
       * 那一个时预填，且一律等用户在面板上点头。缺省 = 没有记录。
       */
      workAuthorizations?: readonly WorkAuthorizationFact[];
      /** 用户亲手存、确认过的推荐人（P1-9）：只有姓名与公司；缺省 = 没有。 */
      referrals?: readonly ReferralFact[];
      /**
       * 服务端要的正是这版插件显示的那一版，而他没同意、也没撤回过：浮层请他一键同意（2026-09-28）。只管摆不摆那张卡。
       * 代不代签不在档案答复里（2026-10-03 体检 P0-1：它在内容脚本里预取、留一分钟，跟着它走的同意撤回之后一分钟之内还会
       * 代签）——填写开始那一刻另要一次 `SIGN_ON_BEHALF`。
       */
      signingReconsent?: true;
      /**
       * 资料里对「可以联系你现在的雇主吗？」确认过的回答（2026-09-28）。不是扁平档案键，单独带；缺省 = 没答，
       * 那一类题交还本人。
       */
      employerContact?: 'YES' | 'NO';
      /**
       * 资料里「出差最多能接受多少？」确认过的回答（2026-10-04，argoland #738）：0／25／50／75／100。不是扁平档案键，单独带；
       * 缺省 = 没答，出差题交还本人。
       */
      travelPercentMax?: 0 | 25 | 50 | 75 | 100;
      /**
       * 用户在门户 EEO 那一节对「是否拉美裔」亲口的回答（2026-09-23）。它不是扁平档案键，
       * 单独带；缺省 = 没答或没同意复用。
       */
      hispanicLatino?: 'YES' | 'NO' | 'DECLINE';
      /**
       * 同一节里对「是否跨性别」与性取向亲口的回答（2026-09-23），同样不是扁平档案键、单独带；
       * 「是否 LGBTQ+」由内核从这两句推出。缺省 = 没答、自行描述或没同意复用。
       */
      transgenderStatus?: 'YES' | 'NO' | 'DECLINE';
      sexualOrientation?: SexualOrientationAnswer;
    }>
  /**
   * 这一页的只读运行时授权（purpose=DISCOVERY）。
   *
   * 无 mission 那条填写路要它来扫这一页：内容脚本的识别只能来自后端下发的规则，
   * 而手势路没有 intent 可抄目标。worker 从同一份 bundle 里按厂商解出映射再签，
   * 什么都没放松——映射仍只从下发包取，厂商的 discovery 开关仍要开，签出来的
   * 仍是宿主策略物理禁用的只读授权。
   *
   * 形状不在这里解：它由 `parseRuntimeExecutionAuthorization` 自己判，
   * 本模块不另立第二套判据。
   */
  | Readonly<{
      kind: 'DISCOVERY_AUTHORITY';
      authorization: unknown;
      /** 此刻登录的是谁（不透明代号；没登录是 null，2026-10-04）：按下去那一刻 worker 现答，用来核对预取的档案。 */
      session?: string | null;
    }>
  /**
   * 此刻代不代签（2026-10-03）：用户在资料页单独勾过「代填授权」、同意着当前文案版本（2026-09-28 起只有当前版本算数）。
   * worker 每次现读后端记录（不缓存）；读不到、解不开、版本不对都是 false。能力位是否放行，内核按生效策略自己再判。
   */
  | Readonly<{ kind: 'SIGN_ON_BEHALF'; granted: boolean }>
  | Readonly<{
      kind: 'RESUMES';
      options: readonly Readonly<{
        resumeVersionId: string;
        trackId: string;
        label: string;
        isDefault: boolean;
      }>[];
    }>
  /**
   * `TIMEOUT`：worker 到点没读完档案（2026-10-04，每个请求 8 秒、整份 15 秒）；`BUSY`：门户正在保存档案，等了约 1 秒再读
   * 一次还在保存（argoland #710 的读锁）。浮层各有各的话，不说成「读不到」。
   * `VENDOR_CLOSED`（2026-10-04）：只读授权给不了，因为这一家此刻没在运行时包里放行（厂商位关着、通用路这一版没放行）。
   * 与 `UNAVAILABLE`（取不到、验不过、说不清）分开：浮层说「这类网站还没开放自动填写」，不说「连不上」。
   */
  | Readonly<{ kind: 'REFUSED'; code: 'AUTH_REQUIRED' | 'PAYWALL_REQUIRED' | 'UNAVAILABLE' | 'TIMEOUT' | 'BUSY' | 'VENDOR_CLOSED' }>;

/**
 * 性取向的闭集（内核 `SEXUAL_ORIENTATION_ANSWERS`）。就地写一份而不是引那个模块：这里在内容脚本的
 * 包里，引进来会把整张门户词表一起带进宿主页面；两份逐项相等由测试钉住。
 */
const ORIENTATION_ANSWERS: ReadonlySet<string> = new Set<SexualOrientationAnswer>([
  'ASEXUAL', 'BISEXUAL_PANSEXUAL', 'GAY', 'HETEROSEXUAL', 'LESBIAN', 'QUEER', 'DECLINE',
]);

const isWorkAnswer = (value: unknown): value is WorkAuthorizationFact['authorizedToWork'] =>
  value === 'YES' || value === 'NO' || value === 'UNSPECIFIED';

/** 会话代号：认得的形状才带（字符串或没登录的 null），别的一律当没带（lib/sessionStamp.ts 的 SESSION_STAMP_PATTERN）。 */
function sessionField(value: unknown): { session?: string | null } {
  return value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/u.test(value)) ? { session: value } : {};
}

export function parseDockApplyMaterialsReply(value: unknown): DockApplyMaterialsReply | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'DISCOVERY_AUTHORITY') {
    return candidate.authorization === null || typeof candidate.authorization !== 'object'
      ? null
      : Object.freeze({ kind: 'DISCOVERY_AUTHORITY' as const, authorization: candidate.authorization, ...sessionField(candidate.session) });
  }
  // 只认字面的 true：任何别的值（缺席、字符串、1）都当没同意。
  if (candidate.kind === 'SIGN_ON_BEHALF') return Object.freeze({ kind: 'SIGN_ON_BEHALF' as const, granted: candidate.granted === true });
  if (candidate.kind === 'PROFILE') {
    const raw = candidate.profile;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const profile: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      // 只收非空字符串：null 与空串对填写而言就是「没有这一项」，
      // 让它们进来只会在下游多一处「有没有值」的判断。
      if (typeof value === 'string' && value !== '') profile[key] = value;
    }
    // 结构化集合可缺。形状由内核自己的有界读判（profileCollections.ts）：一条坏记录只丢
    // 那一条，不让整份档案答复作废——worker 交来的本来就是它自己投影出的形状，
    // 这里的检查是第二道，不是唯一一道。
    const rawCollections = candidate.collections;
    const collections = rawCollections !== null && typeof rawCollections === 'object' && !Array.isArray(rawCollections)
      ? parseApplyProfileCollections(rawCollections)
      : undefined;
    // 工作授权记录：三项闭集，一条坏记录只丢那一条（同集合的有界读纪律）。
    const workAuthorizations = Array.isArray(candidate.workAuthorizations)
      ? candidate.workAuthorizations.flatMap((item): WorkAuthorizationFact[] => {
          if (item === null || typeof item !== 'object') return [];
          const { regionCode, authorizedToWork, requiresSponsorship } = item as Record<string, unknown>;
          if (typeof regionCode !== 'string' || !/^[A-Z]{2}$/u.test(regionCode)) return [];
          if (!isWorkAnswer(authorizedToWork) || !isWorkAnswer(requiresSponsorship)) return [];
          return [Object.freeze({ regionCode, authorizedToWork, requiresSponsorship })];
        })
      : undefined;
    // 推荐人：姓名与公司都得是非空字符串，坏记录只丢那一条。
    const referrals = Array.isArray(candidate.referrals)
      ? candidate.referrals.flatMap((item): ReferralFact[] => {
          if (item === null || typeof item !== 'object') return [];
          const { name, company } = item as Record<string, unknown>;
          if (typeof name !== 'string' || typeof company !== 'string') return [];
          if (name.trim() === '' || company.trim() === '' || name.length > 160 || company.length > 160) return [];
          return [Object.freeze({ name, company })];
        })
      : undefined;
    return Object.freeze({
      kind: 'PROFILE' as const,
      profile: Object.freeze(profile),
      ...sessionField(candidate.session),
      ...(collections === undefined ? {} : { collections }),
      ...(workAuthorizations === undefined ? {} : { workAuthorizations: Object.freeze(workAuthorizations) }),
      ...(referrals === undefined ? {} : { referrals: Object.freeze(referrals) }),
      ...(candidate.signingReconsent === true ? { signingReconsent: true as const } : {}),
      ...(candidate.employerContact === 'YES' || candidate.employerContact === 'NO' ? { employerContact: candidate.employerContact } : {}),
      // 闭集五档，别的一律当没答。
      ...([0, 25, 50, 75, 100].includes(candidate.travelPercentMax as number)
        ? { travelPercentMax: candidate.travelPercentMax as 0 | 25 | 50 | 75 | 100 }
        : {}),
      // 闭集三个词，别的一律当没答。
      ...(candidate.hispanicLatino === 'YES' || candidate.hispanicLatino === 'NO' || candidate.hispanicLatino === 'DECLINE'
        ? { hispanicLatino: candidate.hispanicLatino }
        : {}),
      ...(candidate.transgenderStatus === 'YES' || candidate.transgenderStatus === 'NO' || candidate.transgenderStatus === 'DECLINE'
        ? { transgenderStatus: candidate.transgenderStatus }
        : {}),
      ...(typeof candidate.sexualOrientation === 'string' && ORIENTATION_ANSWERS.has(candidate.sexualOrientation)
        ? { sexualOrientation: candidate.sexualOrientation as SexualOrientationAnswer }
        : {}),
    });
  }
  if (candidate.kind === 'REFUSED') {
    return candidate.code === 'AUTH_REQUIRED' || candidate.code === 'PAYWALL_REQUIRED'
      || candidate.code === 'UNAVAILABLE' || candidate.code === 'TIMEOUT' || candidate.code === 'BUSY'
      || candidate.code === 'VENDOR_CLOSED'
      ? Object.freeze({ kind: 'REFUSED' as const, code: candidate.code })
      : null;
  }
  if (candidate.kind !== 'RESUMES' || !Array.isArray(candidate.options)) return null;
  const options = [];
  for (const raw of candidate.options) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.resumeVersionId !== 'string' || item.resumeVersionId === '' ||
      typeof item.trackId !== 'string' || item.trackId === '' ||
      typeof item.label !== 'string' ||
      typeof item.isDefault !== 'boolean'
    ) return null;
    options.push(Object.freeze({
      resumeVersionId: item.resumeVersionId,
      trackId: item.trackId,
      // 标签是要画在面板上的文字。截断在解码这一层，免得一个异常长的轨道名
      // 把那一幕撑破——上游已经截过，这里是第二道，不是唯一一道。
      label: item.label.slice(0, 120),
      isDefault: item.isDefault,
    }));
  }
  return Object.freeze({ kind: 'RESUMES' as const, options: Object.freeze(options) });
}
