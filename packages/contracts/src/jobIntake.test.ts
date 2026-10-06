import { describe, expect, it } from 'vitest';
import {
  parseCreateJobFromUrlRequest,
  parseCreateJobFromUrlResponse,
} from './jobIntake.ts';

const REQUEST_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const JOB_ID = '2c963f66-afa6-4562-b3fc-3fa85f645717';
const LISTING_ID = '11111111-2222-4333-8444-555555555555';

const request = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: REQUEST_ID,
  applicationUrl: 'https://job-boards.greenhouse.io/anthropic/jobs/4020567008',
  ...overrides,
});

const response = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  created: true,
  job: {
    canonicalJobId: JOB_ID,
    listingId: LISTING_ID,
    atsProvider: 'GREENHOUSE',
    canonicalOrigin: 'https://job-boards.greenhouse.io',
    applicationPathname: '/anthropic/jobs/4020567008',
  },
  ...overrides,
});

describe('job intake request', () => {
  it('admits an ordinary https application URL', () => {
    const parsed = parseCreateJobFromUrlRequest(request());
    expect(parsed).not.toBeNull();
    expect(parsed!.applicationUrl).toBe('https://job-boards.greenhouse.io/anthropic/jobs/4020567008');
  });

  it.each([
    ['the request id is not a uuid', { clientRequestId: 'nope' }],
    ['the URL is not https', { applicationUrl: 'http://job-boards.greenhouse.io/a/jobs/1' }],
    // Credentials in a URL are an exfiltration shape, not an address.
    ['the URL carries credentials', { applicationUrl: 'https://user:pw@job-boards.greenhouse.io/a/jobs/1' }],
    ['the URL carries a fragment', { applicationUrl: 'https://job-boards.greenhouse.io/a/jobs/1#x' }],
    ['the URL is not a URL', { applicationUrl: 'not a url' }],
    ['the URL is empty', { applicationUrl: '' }],
    ['the URL is padded', { applicationUrl: ' https://job-boards.greenhouse.io/a/jobs/1 ' }],
    ['an unknown field is present', { extra: true }],
  ])('refuses a request when %s', (_name, overrides) => {
    expect(parseCreateJobFromUrlRequest(request(overrides))).toBeNull();
  });

  it('refuses a URL long enough to be a payload', () => {
    const long = `https://job-boards.greenhouse.io/a/jobs/1?${'x'.repeat(2100)}`;
    expect(parseCreateJobFromUrlRequest(request({ applicationUrl: long }))).toBeNull();
  });

  it('takes no description of the posting from the caller', () => {
    expect(parseCreateJobFromUrlRequest(request({ title: 'Staff Engineer' }))).toBeNull();
  });
});

describe('job intake response', () => {
  it('admits the identity projection', () => {
    const parsed = parseCreateJobFromUrlResponse(response());
    expect(parsed).not.toBeNull();
    expect(parsed!.job.canonicalJobId).toBe(JOB_ID);
    expect(parsed!.created).toBe(true);
  });

  it.each([
    ['the schema version is wrong', { schemaVersion: 2 }],
    ['created is missing', { created: undefined }],
    ['an unknown top-level field is present', { extra: 1 }],
  ])('refuses a response when %s', (_name, overrides) => {
    const body = response(overrides);
    if ('created' in overrides && overrides.created === undefined) delete (body as Record<string, unknown>).created;
    expect(parseCreateJobFromUrlResponse(body)).toBeNull();
  });

  it('refuses a job projection carrying anything beyond the identity', () => {
    expect(parseCreateJobFromUrlResponse(response({
      job: { ...response().job, title: 'Staff Engineer' },
    }))).toBeNull();
  });

  it('refuses an unknown ATS provider', () => {
    expect(parseCreateJobFromUrlResponse(response({
      job: { ...response().job, atsProvider: 'SOMETHING' },
    }))).toBeNull();
  });
});
