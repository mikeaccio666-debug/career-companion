import { careerRecordId, careerRecordObject } from './career-record-values.ts';
export const CAREER_PROGRESS_KINDS = ['project', 'resume_review', 'practice_review', 'outreach', 'application', 'interview'] as const;
export type CareerProgressCounts = Readonly<Record<typeof CAREER_PROGRESS_KINDS[number], number>>;
export interface CareerProgressSnapshot {
    readonly ownerId: string;
    readonly coverage: readonly ['project', 'application'];
    readonly progress: Readonly<{ policyRevision: 1; counts: CareerProgressCounts; provisionalCounts: CareerProgressCounts; milestones: readonly 'first_project_evidence'[] }>;
}
/** Current source coverage is explicit. Unconnected kinds cannot masquerade as
 * verified activity, and manual applications cannot become confirmed evidence. */
export function parseCareerProgressSnapshot(value: unknown): Readonly<CareerProgressSnapshot> {
    const v = careerRecordObject(value, ['ownerId', 'coverage', 'progress']);
    const ownerId = careerRecordId(v.ownerId);
    const exactArray = (value: unknown, expected: readonly string[]) => {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length || Reflect.ownKeys(value).length !== expected.length + 1) throw Error('Unsupported progress values.');
        const fields = Object.getOwnPropertyDescriptors(value);
        if (expected.some((x, i) => !fields[i] || !('value' in fields[i]) || fields[i].value !== x)) throw Error('Unsupported progress values.');
    };
    exactArray(v.coverage, ['project', 'application']);
    const raw = careerRecordObject(v.progress, ['policyRevision', 'counts', 'provisionalCounts', 'milestones']);
    if (raw.policyRevision !== 1) throw Error('Unsupported progress policy.');
    const counts = (value: unknown): CareerProgressCounts => {
        const r = careerRecordObject(value, [...CAREER_PROGRESS_KINDS]);
        for (const k of CAREER_PROGRESS_KINDS) if (!Number.isSafeInteger(r[k]) || (r[k] as number) < 0 || (r[k] as number) > 500) throw Error('Invalid evidence count.');
        return Object.freeze(Object.fromEntries(CAREER_PROGRESS_KINDS.map(k => [k, r[k]]))) as CareerProgressCounts;
    };
    const confirmed = counts(raw.counts), provisional = counts(raw.provisionalCounts);
    if (confirmed.project + provisional.project > 500 || confirmed.application !== 0 || CAREER_PROGRESS_KINDS.some(k => k !== 'project' && k !== 'application' && (confirmed[k] !== 0 || provisional[k] !== 0))) throw Error('Unsupported evidence claim.');
    const milestones = confirmed.project > 0 ? ['first_project_evidence' as const] : [];
    exactArray(raw.milestones, milestones);
    return Object.freeze({ ownerId, coverage: Object.freeze(['project', 'application'] as const), progress: Object.freeze({ policyRevision: 1, counts: confirmed, provisionalCounts: provisional, milestones: Object.freeze(milestones) }) });
}
