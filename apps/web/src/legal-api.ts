import type { PublicLegalDocuments, StudentConsentStatus, TermsAcceptance } from '@companion/platform-contracts';
import { request, type BoundPlatformClient } from './api.ts';
import { parsePublicLegalDocuments, parseStudentConsent } from './student-entry-state.ts';

export async function readPublicLegalDocuments(signal?: AbortSignal, read: typeof request = request): Promise<PublicLegalDocuments> {
  return parsePublicLegalDocuments(await read('/auth/legal-documents', { signal }));
}
export async function readStudentConsent(client: BoundPlatformClient, signal?: AbortSignal): Promise<StudentConsentStatus> {
  return parseStudentConsent(await client.request('/auth/consent', { signal }), client.account.accountId);
}
export async function acceptStudentConsent(client: BoundPlatformClient, acceptance: TermsAcceptance, signal?: AbortSignal): Promise<StudentConsentStatus> {
  return parseStudentConsent(await client.request('/auth/consent', { method: 'POST', body: JSON.stringify(acceptance), signal }), client.account.accountId);
}
