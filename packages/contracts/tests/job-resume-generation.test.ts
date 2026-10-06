import { describe, expect, it } from 'vitest';
import {
  parseCreateJobResumeGenerationRequestV1,
  parseJobResumeGenerationResponseV1,
} from '../src/jobResumeGeneration.ts';

const CLIENT_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const TRACK_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';

describe('job resume generation contract', () => {
  it('accepts only an opaque canonical selector and exact owner fences', () => {
    const request = {
      clientRequestId: CLIENT_REQUEST_ID,
      trackId: TRACK_ID,
      jobId: 'catalog:greenhouse:example:123',
      expectedProfileRevision: '7',
      expectedProfileDeletionEpoch: '0',
      expectedLibraryRevision: '4',
      layoutTemplateResumeVersionId: null,
    };
    expect(parseCreateJobResumeGenerationRequestV1(request)).toEqual(request);
    expect(parseCreateJobResumeGenerationRequestV1({
      ...request,
      description: 'caller supplied JD',
    })).toBeNull();
    expect(parseCreateJobResumeGenerationRequestV1({
      ...request,
      job: { title: 'Engineer', company: 'Example', description: 'forged' },
    })).toBeNull();
    expect(parseCreateJobResumeGenerationRequestV1({
      ...request,
      expectedProfileRevision: '-1',
    })).toBeNull();
  });

  it('parses the bounded private response and rejects extra content/hash fields', () => {
    const response = validResponse();
    expect(parseJobResumeGenerationResponseV1(response)).toEqual(response);
    expect(parseJobResumeGenerationResponseV1({
      ...response,
      job: { ...response.job, description: 'must not cross the wire' },
    })).toBeNull();
    expect(parseJobResumeGenerationResponseV1({
      ...response,
      renderedPdf: { ...response.renderedPdf, storageKey: 'private/key' },
    })).toBeNull();
    expect(parseJobResumeGenerationResponseV1({
      ...response,
      grounding: { ...response.grounding, unsupportedClaimCount: 1 },
    })).toBeNull();
  });

  // argoland #672（2026-09-29）：质量复核只给建议时，grounding 带 ADVISORY 与一两个建议码；
  // keyEvidenceOmitted 可以是 true。两个成员要么都在、要么都不在，建议码只认闭集、不重复。
  it('accepts the advisory grounding shape and nothing looser', () => {
    const response = validResponse();
    const advisory = {
      ...response,
      grounding: {
        ...response.grounding,
        keyEvidenceOmitted: true,
        qualityDisposition: 'ADVISORY',
        advisories: ['COVERAGE_REFINEMENT_SUGGESTED', 'RESUME_QUALITY_REFINEMENT_REQUIRED'],
      },
    };
    expect(parseJobResumeGenerationResponseV1(advisory)).toEqual(advisory);
    expect(parseJobResumeGenerationResponseV1({
      ...response,
      grounding: { ...response.grounding, keyEvidenceOmitted: true },
    })).not.toBeNull();
    for (const grounding of [
      { ...advisory.grounding, advisories: [] },
      { ...advisory.grounding, advisories: ['COVERAGE_REFINEMENT_SUGGESTED', 'COVERAGE_REFINEMENT_SUGGESTED'] },
      { ...advisory.grounding, advisories: ['SOMETHING_ELSE'] },
      { ...advisory.grounding, qualityDisposition: 'BLOCKING' },
      { ...response.grounding, qualityDisposition: 'ADVISORY' },
    ]) {
      expect(parseJobResumeGenerationResponseV1({ ...response, grounding })).toBeNull();
    }
  });
});

function validResponse() {
  return {
    schemaVersion: 1,
    clientRequestId: CLIENT_REQUEST_ID,
    resumeVersion: {
      resumeVersionId: VERSION_ID,
      trackId: TRACK_ID,
      versionNumber: 2,
      label: 'Software Engineer · Example',
      fileName: `job-resume-${VERSION_ID}.txt`,
      lifecycleStatus: 'READY',
      origin: 'REWRITE',
      contentRevision: '1',
      createdAt: '2026-08-30T12:00:00.000Z',
    },
    job: {
      canonicalJobId: JOB_ID,
      canonicalJobRevision: '9',
      descriptionDigest: `sha256:${'a'.repeat(64)}`,
      title: 'Software Engineer',
      company: 'Example',
    },
    profile: { revision: '7', deletionEpoch: '0' },
    libraryRevision: '6',
    layoutTemplateResumeVersionId: null,
    document: {
      fullName: 'Ada Example',
      email: 'ada@example.test',
      phone: null,
      location: 'Los Angeles, CA',
      links: ['https://example.test'],
      summary: null,
      experiences: [{
        heading: 'Software Engineer',
        organization: 'Example',
        location: null,
        dateRange: '2025 - Present',
        bullets: ['Built reliable APIs'],
      }],
      projects: [],
      educations: [],
      skills: ['TypeScript'],
      languages: [],
    },
    grounding: {
      status: 'VERIFIED',
      selectedEvidenceBlockCount: 1,
      omittedLowerRelevanceBlockCount: 0,
      unsupportedClaimCount: 0,
      softPageTarget: 1,
      estimatedPages: 1,
      keyEvidenceOmitted: false,
    },
    renderedPdf: {
      artifactId: ARTIFACT_ID,
      mimeType: 'application/pdf',
      size: 2048,
    },
  };
}
