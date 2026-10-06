import { describe, expect, it } from 'vitest';

import {
  COMMON_PRIVATE_ERROR_CODES,
  OWNER_PROFILE_V2_ENDPOINTS,
  OWNER_PROFILE_V2_ENDPOINT_ERROR_CODES,
  RESUME_PROFILE_SUGGESTION_MIME_TYPES,
  RESUME_PROFILE_SUGGESTION_REASONS,
  RESUME_PROFILE_SUGGESTION_SCHEMA_VERSION,
  RESUME_PROFILE_SUGGESTION_UPLOAD_MAX_BYTES,
  parseResumeProfileSuggestionSetV1,
  type ResumeProfileSuggestionUploadRequestV1,
} from '../src/index.ts';
import { PROFILE_V2_COLLECTION_LIMITS } from '../src/index.ts';

describe('Resume-to-Profile suggestion wire', () => {
  const candidate = () => ({
    schemaVersion: 1, status: 'PARSED', suggestionSetDigest: `sha256:${'a'.repeat(64)}`,
    extractor: { name: 'resume-profile-suggestions', version: 'v1' }, reason: null, warnings: [],
    truncated: { experiences: false, educations: false, skills: false, links: false },
    suggestions: {
      contacts: { fullName: null, preferredName: null, email: null, phone: null, location: null, city: null },
      links: [], experiences: [], educations: [], skills: [{ value: 'SQL', confidence: 0.8 }],
    },
  });

  it.each([['NOT_EXTRACTABLE'], ['PARSED'], { toString: () => 'PARSED' }, null, 1, true])(
    'rejects non-string status values without coercing them into the status closed set: %j', (status) => {
      const parsed = candidate();
      const empty = { ...parsed, suggestionSetDigest: null, reason: { code: 'NO_DETERMINISTIC_FACTS', retryable: false },
        suggestions: { ...parsed.suggestions, skills: [] } };
      expect(parseResumeProfileSuggestionSetV1({ ...empty, status })).toBeNull();
      expect(parseResumeProfileSuggestionSetV1({ ...parsed, status })).toBeNull();
    },
  );

  it('decodes existing V1 and optional text/diagnostics without changing link provenance', () => {
    const original = candidate();
    expect(parseResumeProfileSuggestionSetV1(original)).toEqual(original);
    const additive = { ...original,
      suggestions: { ...original.suggestions, text: { fullName: { value: 'Lin Wei', source: 'RESUME_TEXT', confidence: 0.9 } } },
      diagnostics: { experiences: { sectionFound: true, datedLines: 2 }, educations: { sectionFound: false, datedLines: 0 } },
    };
    expect(parseResumeProfileSuggestionSetV1(additive)).toEqual(additive);
    expect(parseResumeProfileSuggestionSetV1({ ...additive, suggestions: {
      ...additive.suggestions, text: { fullName: { value: 'Lin Wei', source: 'RESUME_LINK', confidence: 0.9 } },
    } })).toBeNull();
  });

  it('rejects incomplete groups, excessive collections, invalid source, unsafe links and raw diagnostics', () => {
    const original = candidate();
    for (const suggestions of [
      { ...original.suggestions, experiences: [{}] },
      { ...original.suggestions, skills: Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.skills + 1 }, () => ({ value: 'SQL', confidence: 0.8 })) },
      { ...original.suggestions, skills: [{ value: 'SQL', confidence: 2 }] },
      { ...original.suggestions, links: [{ kind: 'website', href: 'javascript:alert(1)', label: 'site', source: 'RESUME_LINK', confidence: 0.9, parserVersion: 'resume-profile-suggestions@v1' }] },
    ]) expect(parseResumeProfileSuggestionSetV1({ ...original, suggestions })).toBeNull();
    expect(parseResumeProfileSuggestionSetV1({ ...original, diagnostics: {
      experiences: { sectionFound: true, datedLines: 2, raw: 'synthetic private text' },
      educations: { sectionFound: false, datedLines: 0 },
    } })).toBeNull();
    expect(parseResumeProfileSuggestionSetV1({ schemaVersion: 1, status: 'PARSED' })).toBeNull();
  });

  it('validates optional deterministic projects and experience descriptions', () => {
    const original = candidate();
    const project = { id: 'project-01', source: 'RESUME_TEXT', confidence: 0.7, fields: {
      title: { value: 'Example Project', confidence: 0.7 }, organization: null,
      startDate: null, endDate: null, isCurrent: null,
      description: { value: 'Built internal tools.', confidence: 0.6 },
    } };
    const withProjects = (projects: unknown) => ({ ...original,
      truncated: { ...original.truncated, projects: false },
      suggestions: { ...original.suggestions, projects },
    });
    expect(parseResumeProfileSuggestionSetV1(withProjects([project]))).not.toBeNull();
    for (const projects of [[{}], [project, project], Array(PROFILE_V2_COLLECTION_LIMITS.projects + 1).fill(project),
      [{ ...project, fields: { ...project.fields, description: { value: 'x'.repeat(2001), confidence: 0.5 } } }],
    ]) expect(parseResumeProfileSuggestionSetV1(withProjects(projects))).toBeNull();
    expect(parseResumeProfileSuggestionSetV1({ ...withProjects([project]), truncated: {
      ...original.truncated, projects: 'no',
    } })).toBeNull();
    const experience = { id: 'experience-01', source: 'RESUME_TEXT', confidence: 0.7,
      fields: { company: null, title: null, startDate: null, endDate: null, isCurrent: null,
        description: { value: 'Built internal tools.', confidence: 0.6 } } };
    expect(parseResumeProfileSuggestionSetV1({ ...original, suggestions: {
      ...original.suggestions, experiences: [experience],
    } })).not.toBeNull();
    expect(parseResumeProfileSuggestionSetV1({ ...original, suggestions: {
      ...original.suggestions, experiences: [{ ...experience, fields: { ...experience.fields, description: { value: 12, confidence: 0.6 } } }],
    } })).toBeNull();
  });

  it('pins the one-shot owner upload endpoint without a Resume Library lifecycle', () => {
    expect(OWNER_PROFILE_V2_ENDPOINTS.createResumeProfileSuggestionsV1).toEqual({
      method: 'POST',
      path: '/users/me/application-profile/resume-suggestions',
      sourceSection: '5.13.4',
      auth: 'bearer',
      responseKind: 'json',
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      requestEncoding: 'multipart/form-data',
      fileField: 'file',
      consentField: 'consent',
      maxFileBytes: RESUME_PROFILE_SUGGESTION_UPLOAD_MAX_BYTES,
      responseCache: {
        responseHeaders: { 'Cache-Control': 'private, no-store' },
        etag: 'forbidden',
      },
    });
    expect(OWNER_PROFILE_V2_ENDPOINT_ERROR_CODES.createResumeProfileSuggestionsV1).toEqual([
      ...COMMON_PRIVATE_ERROR_CODES,
      'PAYWALL_REQUIRED',
    ]);
  });

  it('pins the bounded file and failure closures', () => {
    expect(RESUME_PROFILE_SUGGESTION_SCHEMA_VERSION).toBe(1);
    expect(RESUME_PROFILE_SUGGESTION_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(RESUME_PROFILE_SUGGESTION_MIME_TYPES).toEqual([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    expect(RESUME_PROFILE_SUGGESTION_REASONS).toEqual([
      'NO_EXTRACTABLE_TEXT',
      'LAYOUT_NOT_READABLE',
      'NO_DETERMINISTIC_FACTS',
      'DOCUMENT_PARSE_FAILED',
    ]);
  });

  it('requires explicit upload consent in the logical multipart request', () => {
    const request: ResumeProfileSuggestionUploadRequestV1 = {
      consent: true,
      file: {
        mimeType: 'application/pdf',
        byteLength: 128,
      },
    };
    const missingConsent: ResumeProfileSuggestionUploadRequestV1 = {
      // @ts-expect-error an upload is not authorized without the literal consent value.
      consent: false,
      file: request.file,
    };

    expect(request.consent).toBe(true);
    expect(missingConsent.consent).toBe(false);
  });
});
