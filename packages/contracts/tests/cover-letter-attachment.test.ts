import { describe, expect, it } from 'vitest';
import {
  COVER_LETTER_GENERATION_CODES,
  MISSION_COVER_LETTER_MAX_TEXT_BYTES,
  parseCoverLetterAttachmentLookupRequestV1,
  parseCoverLetterAttachmentLookupV1,
  parseCoverLetterAttachmentPrepareRequestV1,
  parseCoverLetterAttachmentPrepareResultV1,
  parseCoverLetterAttachmentReleaseRequestV1,
  parseCoverLetterAttachmentTextV1,
  parseCoverLetterPageJobV1,
} from '../src/index';

// Page-targeted cover-letter attachments (2026-09-27). Synthetic identifiers only.
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const ARTIFACT = '00000000-0000-4000-8000-000000000002';
const TARGET = { canonicalOrigin: 'https://job-boards.greenhouse.io', jobId: '/acme/jobs/123' };
const GENERATED_AT = '2026-09-27T10:00:00.000Z';
const pageJob = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  title: 'Business Analyst',
  company: 'Acme',
  description: 'Analyse sales data.\n\tBuild weekly reports.',
  source: 'JOB_POSTING',
  ...over,
});

describe('cover-letter attachment wire: requests name the page, never a job text the server trusts', () => {
  it('reads lookup and release requests with exact keys and the resume attachment target', () => {
    expect(parseCoverLetterAttachmentLookupRequestV1({ schemaVersion: 1, target: TARGET }))
      .toEqual({ schemaVersion: 1, target: TARGET });
    expect(parseCoverLetterAttachmentReleaseRequestV1({ schemaVersion: 1, artifactId: ARTIFACT, target: TARGET }))
      .toEqual({ schemaVersion: 1, artifactId: ARTIFACT, target: TARGET });
    for (const bad of [
      { target: TARGET },
      { schemaVersion: 2, target: TARGET },
      { schemaVersion: 1, target: TARGET, jobId: 'catalog:selector' },
      { schemaVersion: 1, target: { ...TARGET, canonicalOrigin: 'http://job-boards.greenhouse.io' } },
      { schemaVersion: 1, target: { ...TARGET, canonicalOrigin: `${TARGET.canonicalOrigin}/` } },
      { schemaVersion: 1, target: { ...TARGET, jobId: '' } },
      { schemaVersion: 1, target: { ...TARGET, extra: true } },
    ]) {
      expect(parseCoverLetterAttachmentLookupRequestV1(bad)).toBeNull();
    }
    for (const bad of [
      { schemaVersion: 1, artifactId: 'not-a-uuid', target: TARGET },
      { schemaVersion: 1, artifactId: ARTIFACT },
      { schemaVersion: 1, artifactId: ARTIFACT, target: TARGET, missionId: REQUEST_ID },
    ]) {
      expect(parseCoverLetterAttachmentReleaseRequestV1(bad)).toBeNull();
    }
  });

  it('reads a prepare request with or without the page job, and nothing else', () => {
    const base = { schemaVersion: 1, clientRequestId: REQUEST_ID, target: TARGET };
    expect(parseCoverLetterAttachmentPrepareRequestV1(base)).toEqual(base);
    expect(parseCoverLetterAttachmentPrepareRequestV1({ ...base, pageJob: pageJob() }))
      .toEqual({ ...base, pageJob: pageJob() });
    for (const bad of [
      { ...base, clientRequestId: 'not-a-uuid' },
      { ...base, clientRequestId: undefined },
      { ...base, pageJob: null },
      { ...base, pageJob: pageJob({ extra: 1 }) },
      { ...base, trigger: 'FORM_REQUIRED' },
      { ...base, jobDescription: 'client-supplied text outside pageJob' },
      { schemaVersion: 1, clientRequestId: REQUEST_ID },
    ]) {
      expect(parseCoverLetterAttachmentPrepareRequestV1(bad)).toBeNull();
    }
  });
});

describe('cover-letter attachment wire: the page job is bounded plain text', () => {
  it('accepts titles, companies and descriptions at their bounds, and an empty company', () => {
    expect(parseCoverLetterPageJobV1(pageJob())).toEqual(pageJob());
    expect(parseCoverLetterPageJobV1(pageJob({ source: 'PAGE_TEXT', company: '' }))).not.toBeNull();
    expect(parseCoverLetterPageJobV1(pageJob({
      title: 't'.repeat(300), company: 'c'.repeat(200), description: 'd'.repeat(20_000),
    }))).not.toBeNull();
  });

  it.each([
    ['title too long', { title: 't'.repeat(301) }],
    ['blank title', { title: '   ' }],
    ['empty title', { title: '' }],
    ['company too long', { company: 'c'.repeat(201) }],
    ['description too long', { description: 'd'.repeat(20_001) }],
    ['blank description', { description: ' \n\t ' }],
    ['carriage return', { description: 'line one\r\nline two' }],
    ['NUL', { description: 'before\u0000after' }],
    ['escape sequence', { title: 'Analyst\u001b[31m' }],
    ['DEL', { company: 'Acme\u007f' }],
    ['C1 control', { description: 'next\u0085line' }],
    ['bidi override', { title: 'Analyst‮evil' }],
    ['bidi isolate', { company: '⁦Acme⁩' }],
    ['lone surrogate', { description: 'broken \ud800 text' }],
    ['unknown source', { source: 'HTML' }],
    ['wrong schema version', { schemaVersion: 2 }],
    ['non-string title', { title: 7 }],
    ['missing company', { company: undefined }],
  ])('rejects %s', (_why, over) => {
    const value = pageJob(over);
    for (const key of Object.keys(value)) {
      if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
    }
    expect(parseCoverLetterPageJobV1(value)).toBeNull();
  });

  it('rejects an extra key and a prototype other than a plain object', () => {
    expect(parseCoverLetterPageJobV1({ ...pageJob(), html: '<p>x</p>' })).toBeNull();
    expect(parseCoverLetterPageJobV1(Object.assign(Object.create({ inherited: true }), pageJob()))).toBeNull();
    expect(parseCoverLetterPageJobV1([pageJob()])).toBeNull();
  });
});

describe('cover-letter attachment wire: answers', () => {
  it('decodes a lookup answer for a catalog or page job, with or without a letter', () => {
    for (const jobSource of ['CATALOG', 'PAGE'] as const) {
      expect(parseCoverLetterAttachmentLookupV1({ schemaVersion: 1, state: 'NONE', jobSource }))
        .toEqual({ schemaVersion: 1, state: 'NONE', jobSource });
      expect(parseCoverLetterAttachmentLookupV1({
        schemaVersion: 1, state: 'READY', jobSource, artifactId: ARTIFACT, generatedAt: GENERATED_AT,
      })).toEqual({ schemaVersion: 1, state: 'READY', jobSource, artifactId: ARTIFACT, generatedAt: GENERATED_AT });
    }
    // 2026-09-28 起「jobSource: 'CLIENT'」读作 PAGE、「NONE 带 artifactId」读作 NONE：见下面「后端先发的加法」。
    for (const bad of [
      { schemaVersion: 1, state: 'NOT_IN_CATALOG' },
      { schemaVersion: 1, state: 'NONE' },
      { schemaVersion: 1, state: 'READY', jobSource: 'CATALOG', artifactId: ARTIFACT },
      { schemaVersion: 1, state: 'READY', jobSource: 'CATALOG', artifactId: 'x', generatedAt: GENERATED_AT },
      { schemaVersion: 1, state: 'READY', jobSource: 'CATALOG', artifactId: ARTIFACT, generatedAt: 'yesterday' },
    ]) {
      expect(parseCoverLetterAttachmentLookupV1(bad)).toBeNull();
    }
  });

  it('decodes a prepare answer: a letter, or a closed failure code that includes the catalog miss', () => {
    const letter = { state: 'READY', artifactId: ARTIFACT, generatedAt: GENERATED_AT };
    expect(parseCoverLetterAttachmentPrepareResultV1({ schemaVersion: 1, ok: true, coverLetter: letter, generated: true }))
      .toEqual({ schemaVersion: 1, ok: true, coverLetter: letter, generated: true });
    expect(parseCoverLetterAttachmentPrepareResultV1({
      schemaVersion: 1, ok: false, code: 'COVER_LETTER_JOB_NOT_IN_CATALOG',
    })).toEqual({ schemaVersion: 1, ok: false, code: 'COVER_LETTER_JOB_NOT_IN_CATALOG' });
    // Every cover-letter product failure still decodes on this route.
    for (const code of COVER_LETTER_GENERATION_CODES) {
      expect(parseCoverLetterAttachmentPrepareResultV1({ schemaVersion: 1, ok: false, code })).not.toBeNull();
    }
    // 2026-09-28 起「code: 'NOT_A_CODE'」读作 COVER_LETTER_UNAVAILABLE、夹带的 text 丢掉不传：见下面「后端先发的加法」。
    for (const bad of [
      { schemaVersion: 1, ok: false, code: 'not a code' },
      { schemaVersion: 1, ok: true, coverLetter: { state: 'NONE' }, generated: false },
      { schemaVersion: 1, ok: true, coverLetter: letter, generated: 'yes' },
    ]) {
      expect(parseCoverLetterAttachmentPrepareResultV1(bad)).toBeNull();
    }
  });

  it('decodes released text within the byte limit and without control characters', () => {
    const text = 'Dear Hiring Team,\n\nPlease consider my application.';
    expect(parseCoverLetterAttachmentTextV1({ schemaVersion: 1, artifactId: ARTIFACT, text }))
      .toEqual({ schemaVersion: 1, artifactId: ARTIFACT, text });
    const atLimit = 'a'.repeat(MISSION_COVER_LETTER_MAX_TEXT_BYTES);
    expect(parseCoverLetterAttachmentTextV1({ schemaVersion: 1, artifactId: ARTIFACT, text: atLimit })).not.toBeNull();
    // Multi-byte text is bounded in bytes, not characters.
    const overInBytes = 'é'.repeat(MISSION_COVER_LETTER_MAX_TEXT_BYTES / 2 + 1);
    for (const bad of [
      { schemaVersion: 1, artifactId: ARTIFACT, text: `${atLimit}a` },
      { schemaVersion: 1, artifactId: ARTIFACT, text: overInBytes },
      { schemaVersion: 1, artifactId: ARTIFACT, text: '   ' },
      { schemaVersion: 1, artifactId: ARTIFACT, text: 'Dear\u0000Team' },
      { schemaVersion: 1, artifactId: ARTIFACT, text: 'Dear ‮Team' },
      { schemaVersion: 1, artifactId: 'x', text },
    ]) {
      expect(parseCoverLetterAttachmentTextV1(bad)).toBeNull();
    }
  });
});

/**
 * 后端先发的加法（2026-09-28）：答复多一个字段，从前旧包整条求职信路停掉。现在多出来的成员不解释、不往下传；
 * 认得的字段照旧逐项校验。闭集里这一版不认识的值只在有安全去处时才收：lookup 的陌生状态读作 NONE（绝不当
 * READY），陌生岗位来源读作 PAGE（要经 prepare 由服务端再认一遍），prepare 的陌生失败码读作笼统的
 * COVER_LETTER_UNAVAILABLE。请求照旧逐键严格（上面第一组）。
 */
describe('cover-letter attachment wire: answers tolerate what the server adds later', () => {
  const LETTER = { state: 'READY', artifactId: ARTIFACT, generatedAt: GENERATED_AT };

  it('lookup: extra members are ignored and never passed on', () => {
    const none = parseCoverLetterAttachmentLookupV1({
      schemaVersion: 1, state: 'NONE', jobSource: 'CATALOG', futureField: { nested: true },
    });
    expect(none).toEqual({ schemaVersion: 1, state: 'NONE', jobSource: 'CATALOG' });
    const ready = parseCoverLetterAttachmentLookupV1({
      schemaVersion: 1, state: 'READY', jobSource: 'PAGE', artifactId: ARTIFACT, generatedAt: GENERATED_AT,
      futureField: 'x', pageJobTitle: 'Business Analyst',
    });
    expect(ready).toEqual({ schemaVersion: 1, state: 'READY', jobSource: 'PAGE', artifactId: ARTIFACT, generatedAt: GENERATED_AT });
    for (const result of [none, ready]) {
      expect(JSON.stringify(result)).not.toContain('futureField');
      expect(Object.isFrozen(result)).toBe(true);
    }
    // NONE 那一形没有 artifactId：带着也只是多出来的成员，不读、不传。
    expect(parseCoverLetterAttachmentLookupV1({ schemaVersion: 1, state: 'NONE', jobSource: 'PAGE', artifactId: ARTIFACT }))
      .toEqual({ schemaVersion: 1, state: 'NONE', jobSource: 'PAGE' });
  });

  it('lookup: a state this build does not know is NONE, never READY, even with a letter id and time', () => {
    for (const state of ['EXPIRED', 'READY_V2', 'NOT_IN_CATALOG', 'R']) {
      expect(parseCoverLetterAttachmentLookupV1({
        schemaVersion: 1, state, jobSource: 'CATALOG', artifactId: ARTIFACT, generatedAt: GENERATED_AT,
      })).toEqual({ schemaVersion: 1, state: 'NONE', jobSource: 'CATALOG' });
    }
  });

  it('lookup: a job source this build does not know is PAGE, the path where the server re-verifies', () => {
    expect(parseCoverLetterAttachmentLookupV1({
      schemaVersion: 1, state: 'READY', jobSource: 'MISSION', artifactId: ARTIFACT, generatedAt: GENERATED_AT,
    })).toEqual({ schemaVersion: 1, state: 'READY', jobSource: 'PAGE', artifactId: ARTIFACT, generatedAt: GENERATED_AT });
    expect(parseCoverLetterAttachmentLookupV1({ schemaVersion: 1, state: 'NONE', jobSource: 'CLIENT' }))
      .toEqual({ schemaVersion: 1, state: 'NONE', jobSource: 'PAGE' });
  });

  it('lookup: malformed known fields still reject', () => {
    const ready = { schemaVersion: 1, state: 'READY', jobSource: 'CATALOG', artifactId: ARTIFACT, generatedAt: GENERATED_AT };
    for (const bad of [
      { ...ready, schemaVersion: 2 },
      { ...ready, schemaVersion: '1' },
      { ...ready, state: 'ready' },
      { ...ready, state: 'Expired' },
      { ...ready, state: 'NOT A STATE' },
      { ...ready, state: '' },
      { ...ready, state: `S${'X'.repeat(32)}` },
      { ...ready, state: 7 },
      { ...ready, state: null },
      { ...ready, jobSource: 'page' },
      { ...ready, jobSource: 'PAGE TEXT' },
      { ...ready, jobSource: '' },
      { ...ready, jobSource: null },
      { ...ready, artifactId: undefined },
      { ...ready, artifactId: '00000000-0000-4000-8000-00000000000A' },
      { ...ready, generatedAt: undefined },
      { ...ready, generatedAt: '2026-09-27' },
      { ...ready, schemaVersion: undefined },
      { ...ready, state: undefined },
      { ...ready, jobSource: undefined },
    ]) {
      expect(parseCoverLetterAttachmentLookupV1(withoutUndefined(bad))).toBeNull();
    }
  });

  it('prepare: extra members at the top and inside the letter are ignored and never passed on', () => {
    const result = parseCoverLetterAttachmentPrepareResultV1({
      schemaVersion: 1, ok: true, generated: false, futureField: 1,
      coverLetter: { ...LETTER, futureField: 2 },
      text: 'Dear Hiring Team,',
    });
    expect(result).toEqual({ schemaVersion: 1, ok: true, coverLetter: LETTER, generated: false });
    expect(JSON.stringify(result)).not.toContain('futureField');
    // 答复里夹带的信文不往下传：信文只走 …/text。
    expect(JSON.stringify(result)).not.toContain('Dear Hiring Team');
    expect(parseCoverLetterAttachmentPrepareResultV1({
      schemaVersion: 1, ok: false, code: 'COVER_LETTER_BUSY', retryAfterSeconds: 30,
    })).toEqual({ schemaVersion: 1, ok: false, code: 'COVER_LETTER_BUSY' });
  });

  it('prepare: a failure code this build does not know reads as the generic COVER_LETTER_UNAVAILABLE', () => {
    for (const code of ['NOT_A_CODE', 'COVER_LETTER_QUOTA_PAUSED', `COVER_LETTER_${'X'.repeat(51)}`]) {
      expect(parseCoverLetterAttachmentPrepareResultV1({ schemaVersion: 1, ok: false, code }))
        .toEqual({ schemaVersion: 1, ok: false, code: 'COVER_LETTER_UNAVAILABLE' });
    }
  });

  it('prepare: malformed known fields still reject', () => {
    const done = { schemaVersion: 1, ok: true, coverLetter: LETTER, generated: true };
    for (const bad of [
      { schemaVersion: 2, ok: false, code: 'COVER_LETTER_BUSY' },
      { schemaVersion: 1, ok: false },
      { schemaVersion: 1, ok: false, code: 'cover_letter_busy' },
      { schemaVersion: 1, ok: false, code: 'COVER LETTER BUSY' },
      { schemaVersion: 1, ok: false, code: `C${'X'.repeat(64)}` },
      { schemaVersion: 1, ok: false, code: 7 },
      { schemaVersion: 1, ok: false, code: null },
      { schemaVersion: 1, ok: 'false', code: 'COVER_LETTER_BUSY' },
      { schemaVersion: 1, code: 'COVER_LETTER_BUSY' },
      { ...done, schemaVersion: 2 },
      { ...done, ok: 'true' },
      { ...done, generated: undefined },
      { ...done, coverLetter: undefined },
      { ...done, coverLetter: null },
      { ...done, coverLetter: [LETTER] },
      { ...done, coverLetter: { ...LETTER, state: 'NONE' } },
      // 信本身的状态照旧只认 READY：一封这一版不认识状态的信不能拿去附。
      { ...done, coverLetter: { ...LETTER, state: 'EXPIRED' } },
      { ...done, coverLetter: { state: 'READY', generatedAt: GENERATED_AT } },
      { ...done, coverLetter: { state: 'READY', artifactId: ARTIFACT } },
      { ...done, coverLetter: { ...LETTER, artifactId: 'x' } },
      { ...done, coverLetter: { ...LETTER, generatedAt: 'yesterday' } },
    ]) {
      expect(parseCoverLetterAttachmentPrepareResultV1(withoutUndefined(bad))).toBeNull();
    }
  });

  it('text: extra members are ignored and never passed on', () => {
    const text = 'Dear Hiring Team,\n\nPlease consider my application.';
    const result = parseCoverLetterAttachmentTextV1({ schemaVersion: 1, artifactId: ARTIFACT, text, target: TARGET, futureField: true });
    expect(result).toEqual({ schemaVersion: 1, artifactId: ARTIFACT, text });
    expect(JSON.stringify(result)).not.toContain('futureField');
    expect(JSON.stringify(result)).not.toContain('greenhouse');
    for (const bad of [
      { schemaVersion: 2, artifactId: ARTIFACT, text },
      { schemaVersion: 1, text },
      { schemaVersion: 1, artifactId: ARTIFACT },
      { schemaVersion: 1, artifactId: ARTIFACT, text: 7 },
    ]) {
      expect(parseCoverLetterAttachmentTextV1(bad)).toBeNull();
    }
  });

  it('answers are still plain JSON objects; prototype-shaped member names and inherited members are refused', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const extra = `"${key}":{"state":"READY"}`;
      expect(parseCoverLetterAttachmentLookupV1(JSON.parse(`{"schemaVersion":1,"state":"NONE","jobSource":"CATALOG",${extra}}`))).toBeNull();
      expect(parseCoverLetterAttachmentPrepareResultV1(JSON.parse(`{"schemaVersion":1,"ok":false,"code":"COVER_LETTER_BUSY",${extra}}`))).toBeNull();
      expect(parseCoverLetterAttachmentPrepareResultV1(JSON.parse(
        `{"schemaVersion":1,"ok":true,"generated":true,"coverLetter":{"state":"READY","artifactId":"${ARTIFACT}","generatedAt":"${GENERATED_AT}",${extra}}}`,
      ))).toBeNull();
      expect(parseCoverLetterAttachmentTextV1(JSON.parse(`{"schemaVersion":1,"artifactId":"${ARTIFACT}","text":"Dear",${extra}}`))).toBeNull();
    }
    const lookup = { schemaVersion: 1, state: 'NONE', jobSource: 'CATALOG' };
    expect(parseCoverLetterAttachmentLookupV1(Object.assign(Object.create({ inherited: true }), lookup))).toBeNull();
    expect(parseCoverLetterAttachmentLookupV1([lookup])).toBeNull();
    expect(parseCoverLetterAttachmentLookupV1(Object.assign(Object.create(null), lookup))).toEqual(lookup);
    // 认得的键必须是答复自己的：原型链上挂着的不算。
    Object.defineProperty(Object.prototype, 'jobSource', { value: 'CATALOG', configurable: true });
    try {
      expect(parseCoverLetterAttachmentLookupV1({ schemaVersion: 1, state: 'NONE' })).toBeNull();
    } finally {
      delete (Object.prototype as Record<string, unknown>).jobSource;
    }
  });
});

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined));
}
