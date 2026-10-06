import type { JobOutcomeReviewInput, JobOutcomeReviewPage, JobOutcomeReviewRecord } from '@companion/platform-contracts';
export const jobId = '61000000-0000-4000-8000-000000000001';
export const requestId = '62000000-0000-4000-8000-000000000001';
export const version = 'a'.repeat(64);
export const input = (changes: Partial<JobOutcomeReviewInput> = {}): JobOutcomeReviewInput => ({ generation: 1, evidenceVersion: version, expectedRevision: 0, requestId, outcome: 'still_unknown', note: 'Fictional personally checked record.', ...changes });
export const record = (changes: Partial<JobOutcomeReviewRecord> = {}): JobOutcomeReviewRecord => ({ id: '63000000-0000-4000-8000-000000000001', jobId, generation: 1, revision: 1, requestId, evidenceVersion: version, outcome: 'still_unknown', note: 'Fictional personally checked record.', provenance: 'user_reported', verified: false, createdAt: '2026-10-06T00:00:00.000Z', ...changes });
export const page = (changes: Partial<JobOutcomeReviewPage> = {}): JobOutcomeReviewPage => ({ jobId, requestedGeneration: 1, currentGeneration: 1, evidence: { version, generation: 1, kind: 'cli', status: 'uncertain', totalAttempts: 1, hasProviderTask: false, cleanupPending: false, reasons: ['job_uncertain'], attempts: [{ attempt: 1, status: 'uncertain', hasProviderTask: false }], attemptsHasMore: false }, writeEligibility: { allowed: true, reason: null }, latestRevision: 0, records: [], hasMore: false, ...changes });
export function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
