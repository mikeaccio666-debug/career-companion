import { hasUnrecognizedProfileAuthorityV2, parseCandidateProfileSnapshotV2, parseUuid } from '@edaix/contracts';
import type { ApplyProfileCollections } from '@edaix/apply-kernel/profileCollections';
import { projectProfileV2Collections } from '@edaix/apply-kernel/profileV2CollectionProjection';
import { currentWorkAuthorizations, type WorkAuthorizationFact } from '@edaix/apply-kernel/profileV2WorkAuthorizations';
import { confirmedReferrals, type ReferralFact } from '@edaix/apply-kernel/profileV2Referrals';
import { confirmedEmployerContact } from '@edaix/apply-kernel/profileV2EmployerContact';
import { confirmedTravelPercentMax, type TravelPercent } from '@edaix/apply-kernel/profileV2Travel';
import type { EmployerContactAnswer } from '@edaix/apply-kernel/signOnBehalf';
import type { ProfileDirectoryTransport } from './profileDirectoryTransport';

/**
 * worker 侧：把用户自己的 Profile V2 变成内核能**按行**取值的集合（P1-8a）。
 *
 * ## 为什么在 worker 里投影，而不是把快照交给内容脚本
 *
 * 集合里的值是要写进雇主表单的，和扁平档案（`profileClient.ts`）同一条纪律：
 * 形状检查站在值的前面、在持凭据的这一侧做。`projectProfileV2Collections` 还要一个
 * **只有 worker 知道**的事实——这份快照是谁的：它把快照绑到刚用 bearer 读它的那个
 * 用户 id 上，别人的档案不会被投影出来。内容脚本收到的是投影结果，不是快照。
 *
 * ## 只投影用户确认过的事实
 *
 * 简历解析出来、用户还没点头的那一段（SUGGESTED）不会进表单——投影层只认
 * `USER_CONFIRMED / DERIVED_CONFIRMED / LEGACY_CONFIRMED`。这与扁平档案端点的口径一致：
 * 放进正式申请的必须是他自己确认过的话。
 *
 * ## 读不到与没有是两回事
 *
 * 未登录、网络、形状不对 → `null`，调用方按「没有分段内容」收口、行内格如实 NO_VALUE；
 * 只记稳定原因码（RULE-GLOBAL-DATA-L1）。档案还没建（`hasStoredProfile: false`）→ `{}`，
 * 那不是故障，不记诊断。这一路的围栏就是这次读本身：手势路没有 chat 批准过的快照可比对，
 * 与 `profileClient` 的 `profileSnapshot: null` 同一个道理。
 */
export const PROFILE_COLLECTIONS_DIAG_CODES = [
  'PROFILE_COLLECTIONS_AUTH_UNAVAILABLE', // 未登录 / 会话没有 user id
  'PROFILE_COLLECTIONS_FETCH_FAILED', // 传输层拒绝或网络
  'PROFILE_COLLECTIONS_RESPONSE_MALFORMED', // 不是合法的 V2 快照
  'PROFILE_COLLECTIONS_PROJECTION_REJECTED', // 快照对不上围栏（版本 / 删除纪元 / 形状）
  // 照读了，但有事实带着这一版不认识的来源／确认状态／来源种类，那几条不算确认过（2026-09-28）。
  'PROFILE_V2_UNRECOGNIZED_AUTHORITY_IGNORED',
] as const;
export type ProfileCollectionsDiagCode = (typeof PROFILE_COLLECTIONS_DIAG_CODES)[number];

export interface ProfileCollectionsProviderDeps {
  /** worker 自己的目录传输：它持 token，按操作名而不是 URL 发请求。 */
  readonly directory: Pick<ProfileDirectoryTransport, 'run'>;
  /** 当前登录用户；快照会绑到这个 id 上。 */
  readonly getUserId: () => Promise<string | null>;
  /** 只记稳定原因码（RULE-GLOBAL-DATA-L1）。 */
  readonly onDiagnostic?: (code: ProfileCollectionsDiagCode) => void;
  readonly now?: () => number;
}

/**
 * 一次 V2 读投影出的两样事实：分段内容（教育 / 经历 / 技能）与此刻有效的工作授权记录。
 * 后者 2026-09-21 起同一次读顺手带出（P1-7 前置）：题目点名国家、用户在那国有确认过的记录，
 * 内核才预填，且一律等用户点头。
 */
export interface ProfileFacts {
  readonly collections: ApplyProfileCollections;
  readonly workAuthorizations: readonly WorkAuthorizationFact[];
  /** 用户亲手存、且确认过的推荐人（P1-9）：只带姓名与公司。 */
  readonly referrals: readonly ReferralFact[];
  /**
   * 资料里对「可以联系你现在的雇主吗？」确认过的回答（2026-09-28）；没答、没确认、老服务端不发这一项 → null
   * （内核把那一类题交还他本人）。
   */
  readonly employerContact: EmployerContactAnswer | null;
  /**
   * 资料里「出差最多能接受多少？」确认过的回答（2026-10-04，argoland #738）；没答、没确认、老服务端不发这一项 → null
   * （内核把出差题交还他本人）。
   */
  readonly travelPercentMax: TravelPercent | null;
}

export interface ProfileCollectionsProvider {
  /** 读不到 → `null`；档案还没建 → `{}`；否则是用户确认过的教育 / 经历 / 技能。 */
  read(): Promise<ProfileFacts | null>;
}

export function createProfileCollectionsProvider(
  deps: ProfileCollectionsProviderDeps,
): ProfileCollectionsProvider {
  const diag = (code: ProfileCollectionsDiagCode): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      // 诊断通道自己坏了不该影响填写。
    }
  };

  const now = deps.now ?? (() => Date.now());
  const EMPTY: ProfileFacts = Object.freeze({ collections: {}, workAuthorizations: [], referrals: [], employerContact: null, travelPercentMax: null });

  async function read(): Promise<ProfileFacts | null> {
    let userId: string | null;
    try {
      userId = await deps.getUserId();
    } catch {
      userId = null;
    }
    const ownerId = userId === null ? null : parseUuid(userId);
    if (ownerId === null) {
      diag('PROFILE_COLLECTIONS_AUTH_UNAVAILABLE');
      return null;
    }

    let answer: Awaited<ReturnType<ProfileDirectoryTransport['run']>> | null;
    try {
      answer = await deps.directory.run('PROFILE_V2_READ');
    } catch {
      answer = null;
    }
    if (answer === null || !answer.ok) {
      diag(answer?.code === 'LOGIN_REQUIRED'
        ? 'PROFILE_COLLECTIONS_AUTH_UNAVAILABLE'
        : 'PROFILE_COLLECTIONS_FETCH_FAILED');
      return null;
    }

    // 传输层刻意只交文本（见 profileDirectoryTransport.ts 头注）：形状检查在这里，
    // 走的是契约自己的解析器，解析不过整份丢弃。
    let raw: unknown;
    try {
      raw = JSON.parse(answer.text);
    } catch {
      diag('PROFILE_COLLECTIONS_RESPONSE_MALFORMED');
      return null;
    }
    const snapshot = parseCandidateProfileSnapshotV2(raw);
    if (snapshot === null) {
      diag('PROFILE_COLLECTIONS_RESPONSE_MALFORMED');
      return null;
    }
    // 后端先发的加法：元数据里这一版不认识的来源、确认状态或来源种类（2026-09-28 起照读、不算已确认）。
    if (hasUnrecognizedProfileAuthorityV2(snapshot)) diag('PROFILE_V2_UNRECOGNIZED_AUTHORITY_IGNORED');

    const projection = projectProfileV2Collections({
      authenticatedOwnerId: ownerId,
      ownerBoundSnapshot: { ownerId, snapshot },
      // 这一路的围栏就是这次读本身（头注「读不到与没有是两回事」）。
      expectedProfileRevision: snapshot.revision,
      expectedDeletionEpoch: snapshot.deletionEpoch,
    });
    if (!projection.ok) {
      if (
        projection.reasonCode === 'PROFILE_SOURCE_PROFILE_MISSING' ||
        projection.reasonCode === 'PROFILE_SOURCE_PROFILE_DELETED'
      ) {
        return EMPTY;
      }
      diag('PROFILE_COLLECTIONS_PROJECTION_REJECTED');
      return null;
    }
    return Object.freeze({
      collections: projection.value.collections,
      workAuthorizations: currentWorkAuthorizations(snapshot, now()),
      referrals: confirmedReferrals(snapshot),
      employerContact: confirmedEmployerContact(snapshot),
      travelPercentMax: confirmedTravelPercentMax(snapshot),
    });
  }

  return Object.freeze({ read });
}
