/** Public O0 metadata. These values describe server state; they grant no execution rights. */
export type LegalAvailability = { status: 'unavailable' } | { status: 'available'; version: string; digest: string };
export type PublicLegalDocuments = { status: 'unavailable' } | {
  status: 'available'; version: string; digest: string;
  terms: { title: string; body: string }; privacy: { title: string; body: string }; dataNotice: string;
};
export interface StudentAuthOptions {
  emailActionsEnabled: boolean; requireVerifiedEmail: boolean; requireInvite: boolean; legal: LegalAvailability;
}
export interface TermsAcceptance { accepted: true; version: string; digest: string; }
export interface StudentConsentStatus {
  userId: string; status: 'unavailable' | 'required' | 'current'; version: string | null; digest: string | null;
}
export interface StudentRegistrationInput {
  email: string; password: string; name: string; inviteCode?: string; consent: TermsAcceptance;
}
