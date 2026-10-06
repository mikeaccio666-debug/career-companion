import { expect, it } from 'vitest';
import { parseJobCardView } from '../src/job-card.ts';
import { ATS_PROVIDER_CODES, SOURCE_PLATFORM_CODES } from '../src/missions.ts';

const card = { jobId: 'job-test', company: 'Example', title: 'Engineer', location: null, employmentType: null,
  atsProvider: ATS_PROVIDER_CODES[0], sourcePlatform: SOURCE_PLATFORM_CODES[0], qualification: {
    eligibility: 'ELIGIBLE', score: null, scoreScale: 100, reasons: [], risks: [], missingRequirements: [],
    sponsorship: { status: 'UNKNOWN', sourceCode: 'UNKNOWN', confidence: null }, referralAvailability: 'UNKNOWN',
  } };
it('validates the same closed JobCard shape for backend and private Assistant consumers', () => {
  expect(parseJobCardView(card)).toEqual(card);
  expect(parseJobCardView({ ...card, selector: 'input' })).toBeNull();
  expect(parseJobCardView({ ...card, title: 'x'.repeat(513) })).toBeNull();
  expect(parseJobCardView({ ...card, qualification: { ...card.qualification, score: NaN } })).toBeNull();
  expect(parseJobCardView({ ...card, qualification: { ...card.qualification, reasons: [{ code: 'UNKNOWN', defaultText: '', safeParams: {} }] } })).toBeNull();
});
it('requires both policy-qualified card fields and rejects either orphan',()=>{
 const complete={...card,qualification:{...card.qualification,locationTier:null,pendingConfirmations:[]}};
 expect(parseJobCardView(complete)).toEqual(complete);
 expect(parseJobCardView({...card,qualification:{...card.qualification,locationTier:null}})).toBeNull();
 expect(parseJobCardView({...card,qualification:{...card.qualification,pendingConfirmations:[]}})).toBeNull();
});
