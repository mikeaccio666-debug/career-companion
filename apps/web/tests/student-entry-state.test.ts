import assert from 'node:assert/strict';
import test from 'node:test';
import { canOpenAuthenticatedAccount, canOpenPrivateWorkspace, parseAuthOptions, studentAccountEntryStep } from '../src/account-actions.ts';
import { isCurrentStudentConsent, legalDocumentsMatch, parseLegalAvailability, parsePublicLegalDocuments, parseStudentConsent, publicLegalPage, studentEntryFailure, studentRegistrationInput, termsAcceptance } from '../src/student-entry-state.ts';

const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const legal = { status: 'available' as const, version: 'fictional-v1', digest: 'a'.repeat(64) };
const documents = { ...legal, terms: { title: 'Fictional terms', body: 'Fictional terms body.\n虚构测试正文。' }, privacy: { title: 'Fictional privacy', body: 'Fictional privacy body.' }, dataNotice: 'Fictional data handling notice.' };
const options = parseAuthOptions({ emailActionsEnabled: false, requireVerifiedEmail: false, requireInvite: true, legal });
const input = { email: ' fictional@example.invalid ', password: 'fictional-password', name: ' Fictional student ', inviteCode: ' fictional-invite-code-001 ' };
const current = { userId: A, status: 'current' as const, version: legal.version, digest: legal.digest };

test('missing or malformed approved document metadata defaults to unavailable while login metadata remains usable', () => {
  for (const value of [undefined, null, {}, { ...legal, status: 'draft' }, { status: 'available', version: '' }, { ...legal, digest: 'invalid' }]) {
    assert.deepEqual(parseLegalAvailability(value), { status: 'unavailable' });
    assert.equal(legalDocumentsMatch(parseAuthOptions({ ...options, legal: value }), documents), false);
  }
  assert.equal(canOpenAuthenticatedAccount(parseAuthOptions({ ...options, legal: null }), { emailVerified: true }, null), true);
  assert.equal(canOpenPrivateWorkspace(parseAuthOptions({ ...options, legal: null }), { id: A }, null, current), false);
});

test('both full documents and the data notice are required; returned legal text is preserved exactly', () => {
  assert.deepEqual(parsePublicLegalDocuments(documents), documents);
  assert.deepEqual(parsePublicLegalDocuments({ status: 'unavailable' }), { status: 'unavailable' });
  for (const patch of [{ terms: undefined }, { privacy: { title: 'Fictional', body: ' ' } }, { dataNotice: '' }, { version: '' }, { digest: 'b'.repeat(63) }]) assert.throws(() => parsePublicLegalDocuments({ ...documents, ...patch }));
  assert.equal(legalDocumentsMatch(options, { ...documents, digest: 'b'.repeat(64) }), false);
  assert.equal(legalDocumentsMatch(options, { ...documents, version: 'fictional-v2' }), false);
});

test('unchecked, unavailable and stale legal selections cannot build a registration or consent request', () => {
  for (const [availableOptions, availableDocuments, accepted] of [[options, documents, false], [options, null, true], [options, { status: 'unavailable' }, true], [options, { ...documents, version: 'fictional-v2' }, true], [{ ...options, legal: { status: 'unavailable' } }, documents, true]] as const) {
    assert.throws(() => studentRegistrationInput(availableOptions, availableDocuments, accepted, input));
    assert.throws(() => termsAcceptance(availableOptions, availableDocuments, accepted));
  }
  assert.deepEqual(studentRegistrationInput(options, documents, true, input), { email: 'fictional@example.invalid', password: input.password, name: 'Fictional student', inviteCode: 'fictional-invite-code-001', consent: { accepted: true, version: legal.version, digest: legal.digest } });
  const openRegistration = studentRegistrationInput({ ...options, requireInvite: false }, documents, true, { ...input, inviteCode: '', name: '' });
  assert.equal(Object.hasOwn(openRegistration, 'inviteCode'), false); assert.equal(openRegistration.name, 'fictional');
  assert.throws(() => studentRegistrationInput(options, documents, true, { ...input, inviteCode: '' }));
  assert.throws(() => studentRegistrationInput(options, documents, true, { ...input, inviteCode: 'short' }));
  assert.throws(() => studentRegistrationInput(options, documents, true, { ...input, password: 'short' }));
});

test('old accounts, different owners, old versions and unavailable records never establish current consent', () => {
  assert.deepEqual(parseStudentConsent({ consent: current }, A), current);
  assert.equal(canOpenPrivateWorkspace(options, { id: A }, null, current), true);
  for (const consent of [null, { ...current, userId: B }, { ...current, status: 'required' as const }, { ...current, status: 'unavailable' as const }, { ...current, version: 'fictional-v0' }, { ...current, digest: 'b'.repeat(64) }]) assert.equal(isCurrentStudentConsent(options, A, consent), false);
  for (const value of [null, {}, { consent: { ...current, userId: B } }, { consent: { ...current, status: 'approved' } }, { consent: { ...current, version: null } }, { consent: { ...current, digest: null } }]) assert.throws(() => parseStudentConsent(value, A));
  assert.equal(canOpenPrivateWorkspace(options, { id: A }, { kind: 'verify-email', token: 'A'.repeat(43) }, current), false);
});

test('public legal routes are exact and independent of authentication or workspace flags', () => {
  assert.equal(publicLegalPage('/terms'), 'terms'); assert.equal(publicLegalPage('/privacy'), 'privacy');
  for (const path of ['/', '/welcome', '/me/privacy', '/terms/other', '/privacy-old']) assert.equal(publicLegalPage(path), null);
});

test('password recovery and mailbox verification stay first; even current legacy accounts stop at welcome', () => {
  const verified = { id: A, emailVerified: true }, production = { ...options, requireVerifiedEmail: true };
  assert.equal(studentAccountEntryStep(production, null, null, null), 'auth');
  assert.equal(studentAccountEntryStep(production, null, { kind: 'verify-email', token: 'A'.repeat(43) }, null), 'auth');
  assert.equal(studentAccountEntryStep(production, verified, { kind: 'password-reset', token: 'A'.repeat(43) }, current), 'account-action');
  assert.equal(studentAccountEntryStep(production, verified, { kind: 'verify-email', token: 'A'.repeat(43) }, current), 'account-action');
  assert.equal(studentAccountEntryStep(production, { id: A }, null, current), 'email-verification');
  assert.equal(studentAccountEntryStep(production, verified, null, null), 'consent');
  for (const workbench of [false, true]) assert.equal(studentAccountEntryStep({ ...production, workbench } as typeof production, verified, null, current), 'welcome');
});

test('accessor legal values cannot run while selecting a version or rendering document text', () => {
  let reads = 0;
  const value = Object.defineProperty({}, 'status', { enumerable: true, get() { reads++; return 'available'; } });
  assert.deepEqual(parseLegalAvailability(value), { status: 'unavailable' }); assert.throws(() => parsePublicLegalDocuments(value)); assert.equal(reads, 0);
});

test('entry errors explain version and invite recovery without echoing server content or secrets', () => {
  assert.match(studentEntryFailure({ code: 'TERMS_VERSION_CHANGED' }), /刷新后重新阅读/);
  assert.match(studentEntryFailure({ code: 'INVITE_INVALID' }), /收到邀请的邮箱/);
  for (const code of ['INVITE_REQUIRED', 'INVITE_INVALID', 'TERMS_VERSION_CHANGED', 'LEGAL_DOCUMENTS_UNAVAILABLE', 'EMAIL_EXISTS', 'INVALID_CREDENTIALS', 'REQUEST_LIMIT_REACHED', 'INVALID_REQUEST', 'fictional-secret']) assert.equal(studentEntryFailure({ code, message: 'fictional-secret private text' }).includes('fictional-secret'), false);
});

test('real INVALID_INPUT and transport INVALID_REQUEST share the controlled entry guidance',()=>{
  assert.equal(studentEntryFailure({code:'INVALID_INPUT',message:'fictional private backend value'}),studentEntryFailure({code:'INVALID_REQUEST'}));
  assert.match(studentEntryFailure({code:'INVALID_INPUT'}),/邮箱、密码和邀请码/);
});
