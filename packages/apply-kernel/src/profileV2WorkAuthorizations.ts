import {
  PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1,
  PROFILE_V2_FACT_SOURCES,
  PROFILE_V2_SOURCE_REF_KINDS,
  type CandidateProfileSnapshotV2,
  type ProfileFieldAuthorityV2,
} from '@edaix/contracts';

/**
 * Profile V2 的工作授权记录 → 内核预填认的那三项（P1-7 前置；2026-09-21）。
 *
 * ## 围栏逐字照 argoland 的答案源投影（`application-profile-answer-source.projector.ts`）
 *
 *  · 已撤销（`revokedAt`）的不算；
 *  · 生效时间必须已到、过期时间（若有）必须还没到，且过期晚于生效；
 *  · 记录本身要有正的版本号（0 是「还没确认过」）；
 *  · 国家码与用到的那个答案字段都要有**用户确认过**的事实权威（删除纪元与快照一致、
 *    事实版本为正、状态在确认闭集里；USER_CONFIRMED 还得带确认时间）；
 *  · 答案 UNSPECIFIED 等于没有答案。
 *
 * 一条记录里两个答案各自过闸：一个过、一个没过，就只带过了的那个，另一个写 UNSPECIFIED——
 * 内核对 UNSPECIFIED 不预填。两个都没过就整条不带。
 *
 * ## 为什么在 kernel 而不是 worker
 *
 * 这是确定性的纯判断，两条填写路都要用，而且它决定的是「哪一条记录能替用户向雇主陈述
 * 法律资格」——这种判据放在可单测的地方，不放在持凭据的进程里。输入是契约解析器已经
 * 验过形状的快照，不再做原型防御。
 */
export interface WorkAuthorizationFact {
  readonly regionCode: string;
  readonly authorizedToWork: 'YES' | 'NO' | 'UNSPECIFIED';
  readonly requiresSponsorship: 'YES' | 'NO' | 'UNSPECIFIED';
}

const CONFIRMED: ReadonlySet<string> = new Set(PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1);
/**
 * 契约解析器从 2026-09-28 起放行元数据里**这一版不认识的**来源与来源种类（原样留着、不再整份
 * 拒收）。这里把它们挡在「已确认」之外：陌生值能让一条事实失效，不能让它升格。对这一版认得的
 * 每一个值，这道闸与从前逐字相同——从前的解析器根本不会把陌生值交到这里。
 */
const KNOWN_SOURCES: ReadonlySet<string> = new Set(PROFILE_V2_FACT_SOURCES);
const KNOWN_SOURCE_REF_KINDS: ReadonlySet<string> = new Set(PROFILE_V2_SOURCE_REF_KINDS);
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,18}$/u;

function timestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 这一格的事实权威是不是「用户确认过、此刻有效」——集合项能不能替用户向雇主陈述，就看这一条。 */
export function isUserConfirmedAuthority(
  authority: ProfileFieldAuthorityV2 | undefined,
  snapshot: CandidateProfileSnapshotV2,
): boolean {
  if (authority === undefined) return false;
  if (authority.deletionEpoch !== snapshot.deletionEpoch) return false;
  if (!POSITIVE_DECIMAL.test(authority.factRevision)) return false;
  if (!CONFIRMED.has(authority.meta.authorityState)) return false;
  if (authority.meta.authorityState === 'USER_CONFIRMED' && authority.meta.userConfirmedAt === null) return false;
  if (!KNOWN_SOURCES.has(authority.meta.source)) return false;
  if (authority.meta.sourceRef !== null && !KNOWN_SOURCE_REF_KINDS.has(authority.meta.sourceRef.kind)) return false;
  return true;
}

export function currentWorkAuthorizations(
  snapshot: CandidateProfileSnapshotV2,
  nowMs: number,
): readonly WorkAuthorizationFact[] {
  if (!Number.isFinite(nowMs)) return [];
  const facts: WorkAuthorizationFact[] = [];
  for (const record of snapshot.profile.workAuthorizations) {
    if (record.revokedAt !== null) continue;
    const effectiveAt = timestampMs(record.effectiveAt);
    const expiresAt = timestampMs(record.expiresAt);
    if (effectiveAt === null || (record.expiresAt !== null && expiresAt === null)) continue;
    if (expiresAt !== null && expiresAt <= effectiveAt) continue;
    if (effectiveAt > nowMs) continue;
    if (expiresAt !== null && nowMs >= expiresAt) continue;
    if (!POSITIVE_DECIMAL.test(record.revision)) continue;
    if (!isUserConfirmedAuthority(record.factAuthorityByField.regionCode, snapshot)) continue;

    const answer = (field: 'authorizedToWork' | 'requiresSponsorship'): WorkAuthorizationFact['authorizedToWork'] => {
      const value = record[field];
      if (value === 'UNSPECIFIED') return 'UNSPECIFIED';
      return isUserConfirmedAuthority(record.factAuthorityByField[field], snapshot) ? value : 'UNSPECIFIED';
    };
    const authorizedToWork = answer('authorizedToWork');
    const requiresSponsorship = answer('requiresSponsorship');
    if (authorizedToWork === 'UNSPECIFIED' && requiresSponsorship === 'UNSPECIFIED') continue;
    facts.push(Object.freeze({ regionCode: record.regionCode, authorizedToWork, requiresSponsorship }));
  }
  return Object.freeze(facts);
}
