import type { CandidateProfileSnapshotV2 } from '@edaix/contracts';

import { isUserConfirmedAuthority } from './profileV2WorkAuthorizations';

/**
 * 出差上限的闭集（Profile V2 `PROFILE_V2_TRAVEL_PERCENTS`，工作时间的百分比）。定义在这里而不是 dict/travel.ts：worker 的投影
 * 只要这张闭集，不该把判读出差题的那一套打进 background。
 */
export const TRAVEL_PERCENTS = [0, 25, 50, 75, 100] as const;
export type TravelPercent = (typeof TRAVEL_PERCENTS)[number];

export function parseTravelPercent(value: unknown): TravelPercent | null {
  return (TRAVEL_PERCENTS as readonly unknown[]).includes(value) ? (value as TravelPercent) : null;
}

/**
 * Profile V2 的「出差最多能接受多少？」（`preferences.travelPercentMax`，2026-10-04，argoland #738）→ 内核认的上限。
 *
 * 只投影**用户确认过**的那一格：这一问只在门户资料页由他本人回答（简历里读不出来）。没答（null）、旧服务端不发这一项、
 * 不在五档里、确认不成立 → null，内核把出差题交还他本人（或交给 AI）。
 */
export function confirmedTravelPercentMax(snapshot: CandidateProfileSnapshotV2): TravelPercent | null {
  const preferences = snapshot.profile.preferences as { travelPercentMax?: unknown } | null | undefined;
  const value = parseTravelPercent(preferences?.travelPercentMax ?? null);
  if (value === null) return null;
  if (!isUserConfirmedAuthority(snapshot.profile.scalarAuthorityByPath['preferences.travelPercentMax'], snapshot)) return null;
  return value;
}
