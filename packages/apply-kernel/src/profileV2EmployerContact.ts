import type { CandidateProfileSnapshotV2 } from '@edaix/contracts';

import type { EmployerContactAnswer } from './dict/signOnBehalf';
import { isUserConfirmedAuthority } from './profileV2WorkAuthorizations';

/**
 * Profile V2 的「可以联系你现在的雇主吗？」（`preferences.contactCurrentEmployer`，2026-09-28）→ 内核认的回答。
 *
 * 只投影**用户确认过**的那一格：这一问只在门户资料页由他本人回答（简历里读不出来），没点头的值同样不该替他向
 * 雇主表态。没答（null）、旧服务端不发这一项、确认不成立 → null，内核把那一类题交还他本人。
 */
export function confirmedEmployerContact(snapshot: CandidateProfileSnapshotV2): EmployerContactAnswer | null {
  const value = snapshot.profile.preferences?.contactCurrentEmployer ?? null;
  if (value === null) return null;
  if (!isUserConfirmedAuthority(snapshot.profile.scalarAuthorityByPath['preferences.contactCurrentEmployer'], snapshot)) return null;
  return value ? 'YES' : 'NO';
}
