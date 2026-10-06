import type { CareerEvidence, CareerEvidenceKind, CareerProgress } from './contracts.ts';

const kinds: CareerEvidenceKind[] = ['project', 'resume_review', 'practice_review', 'outreach', 'application', 'interview'];
const milestoneByKind = { project: 'first_project_evidence', resume_review: 'first_reviewed_resume', practice_review: 'first_reviewed_practice', outreach: 'first_confirmed_outreach', application: 'first_confirmed_application', interview: 'first_confirmed_interview' } as const;
const counts = (): Record<CareerEvidenceKind, number> => ({ project: 0, resume_review: 0, practice_review: 0, outreach: 0, application: 0, interview: 0 });
const confirmed = (evidence: CareerEvidence): boolean => {
  if (evidence.verification === 'mentor_reviewed') {
    const review = evidence.mentorReview;
    return Boolean(review?.reviewerId.trim() && review.scope === evidence.kind && review.rubricRevision.trim() && Number.isFinite(Date.parse(review.reviewedAt)));
  }
  return ['project', 'outreach', 'application', 'interview'].includes(evidence.kind) && evidence.verification === 'user_confirmed';
};

/** Derive from a current authenticated ledger snapshot; ingestion must verify receipts/reviewers. */
export function careerProgress(ownerId: string, evidence: readonly CareerEvidence[]): CareerProgress {
  if (!ownerId.trim()) throw new Error('Authenticated owner is required.');
  const confirmedSubjects = new Map<CareerEvidenceKind, Set<string>>(kinds.map(kind => [kind, new Set()]));
  const provisionalSubjects = new Map<CareerEvidenceKind, Set<string>>(kinds.map(kind => [kind, new Set()]));
  const withdrawn = new Set<string>();
  const subjectKey = (entry: CareerEvidence) => JSON.stringify([entry.kind, entry.subjectId]);
  for (const entry of evidence) if (entry.ownerId === ownerId && (entry.state === 'withdrawn' || entry.state === 'rejected')) withdrawn.add(subjectKey(entry));
  for (const entry of evidence) {
    if (entry.ownerId !== ownerId || entry.state !== 'active' || !kinds.includes(entry.kind) || !entry.id.trim() || !entry.subjectId.trim() || !entry.referenceId?.trim() || !Number.isFinite(Date.parse(entry.occurredAt)) || withdrawn.has(subjectKey(entry))) continue;
    (confirmed(entry) ? confirmedSubjects : provisionalSubjects).get(entry.kind)!.add(entry.subjectId);
  }
  const result: CareerProgress = { policyRevision: 1, counts: counts(), provisionalCounts: counts(), milestones: [] };
  for (const kind of kinds) {
    const verified = confirmedSubjects.get(kind)!;
    result.counts[kind] = verified.size;
    result.provisionalCounts[kind] = [...provisionalSubjects.get(kind)!].filter(subject => !verified.has(subject)).length;
    if (verified.size) result.milestones.push(milestoneByKind[kind]);
  }
  return result;
}
