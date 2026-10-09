import { resolveZonedTime } from './zoned-date-time.ts';
export interface JobDeadlineDraft { readonly localTime: string; readonly timeZone: string; readonly selectedInstant: string; }
export const emptyJobDeadline = (): JobDeadlineDraft => ({ localTime: '', timeZone: '', selectedInstant: '' });
export function resolveJobDeadline(draft: JobDeadlineDraft) {
  if (!draft.localTime && !draft.timeZone && !draft.selectedInstant) return {
    kind: 'none' as const, message: '', candidates: [], selected: null, savable: true,
  };
  const resolution = resolveZonedTime(draft.localTime, draft.timeZone);
  const selected = resolution.candidates.find(candidate => candidate.instant === draft.selectedInstant)
    ?? (resolution.kind === 'valid' && !draft.selectedInstant ? resolution.candidates[0] : null);
  return { ...resolution, selected, savable: Boolean(selected) };
}
/** Re-resolve at submission; an old overlap choice cannot change another wall time. */
export function jobDeadlineFields(draft: JobDeadlineDraft): { deadlineAt: string | null; deadlineTimeZone: string | null } {
  const resolved = resolveJobDeadline(draft);
  if (!resolved.savable) throw Error(resolved.message || '请重新核对截止时间和时区。');
  return { deadlineAt: resolved.selected?.instant ?? null, deadlineTimeZone: resolved.selected?.timeZone ?? null };
}
