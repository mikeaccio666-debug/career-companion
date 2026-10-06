import type { CandidateProfileSnapshotV2 } from '@edaix/contracts';

import { isUserConfirmedAuthority } from './profileV2WorkAuthorizations';

/**
 * Profile V2 的推荐人 → 内核预填认的两项（P1-9）。
 *
 * 只投影**用户确认过**姓名与公司两格的记录：推荐人是用户亲手录入的（简历里读不出来），
 * 但录入后没点头的那一条同样不该替他向雇主陈述。`relationship` 是给用户看的备注，不出这一层。
 * 快照里没有这一组（argoland 加上它之前的服务端）→ 空。
 */
export interface ReferralFact {
  readonly name: string;
  readonly company: string;
}

export function confirmedReferrals(snapshot: CandidateProfileSnapshotV2): readonly ReferralFact[] {
  const facts: ReferralFact[] = [];
  for (const item of snapshot.profile.referrals ?? []) {
    if (!isUserConfirmedAuthority(item.factAuthorityByField.name, snapshot)) continue;
    if (!isUserConfirmedAuthority(item.factAuthorityByField.company, snapshot)) continue;
    facts.push(Object.freeze({ name: item.name, company: item.company }));
  }
  return Object.freeze(facts);
}
