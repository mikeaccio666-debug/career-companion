import { expect, it } from 'vitest';
import { parseAtsReport, parseAtsReportRequest, parseAtsReportResponse } from '../src/ats-reports.ts';
const id = '11111111-1111-4111-8111-111111111111';
const report = { total: 75.5, max: 100, dimensions: { A: { label: 'Skills', score: 18.5, max: 30, problems: ['Add evidence'] }, B: null, C: null, D: null, E: null, F: null },
  problems: [], suggestions: ['Use a measurable example'], missingKeywords: ['TypeScript'], rubricVersion: 'fixture-v1', measuredAt: '2026-09-13T00:00:00.000Z' };
it('keeps fractional scores and missing dimensions distinct from zero', () => {
  expect(parseAtsReport(report)).not.toBeNull();
  expect(parseAtsReport({ ...report, dimensions: { ...report.dimensions, A: { ...report.dimensions.A, score: 0 } } })).not.toBeNull();
  for (const score of [-1, 31, NaN, null]) expect(parseAtsReport({ ...report, dimensions: { ...report.dimensions, A: { ...report.dimensions.A, score } } })).toBeNull();
});
it('requires exact entry and selected resume; no caller-supplied score or quota', () => {
  expect(parseAtsReportRequest({ entryId: id, resumeVersionId: id })).not.toBeNull();
  expect(parseAtsReportRequest({ entryId: id, resumeVersionId: id, score: 99 })).toBeNull();
});
it('never exposes unfinished or failed work as a completed report', () => {
  const view = { source: {resumeHash:'a'.repeat(64),resumeRevision:1,canonicalJobId:id,canonicalJobRevision:'1',listingGenerationKey:'g1',descriptionDigest:'sha256:'+'b'.repeat(64),providerIdentity:'c'.repeat(64)}, schemaVersion: 1, id, entryId: id, resumeVersionId: id, status: 'SUCCEEDED', failureCode: null, report };
  expect(parseAtsReportResponse(view)).not.toBeNull();
  expect(parseAtsReportResponse({ ...view, status: 'QUEUED' })).toBeNull();
  expect(parseAtsReportResponse({ ...view, status: 'FAILED', report: null, failureCode: 'PROVIDER_UNAVAILABLE' })).not.toBeNull();
  expect(parseAtsReportResponse({ ...view, status: 'FAILED', report: null, failureCode: 'raw provider error' })).toBeNull();
  expect(parseAtsReport({ ...report, upstreamRaw: 'private' })).toBeNull();
});
