import type { OnboardingAction, OnboardingCommand, OnboardingEntryState, OnboardingSafetyPublication } from '@companion/platform-contracts';

/** A fresh account has no draft yet; only its explicit start operation can create one on the server. */
export function onboardingDraftCommand(entry: OnboardingEntryState, action: OnboardingAction, operationId: string): OnboardingCommand {
  if (!entry.draft && action.kind !== 'start') throw new Error('先从初见开场继续。');
  return { operationId, expectedRevision: entry.draft?.revision ?? 0, action };
}

export interface OnboardingPresentation { receipt: string; acknowledgedReceipt: string | null; }
/** Historical acknowledgments never authorize a newly presented handle after refresh or account change. */
export function onboardingContinuationAvailable(publication: OnboardingSafetyPublication, presentation: OnboardingPresentation | undefined): boolean {
  return !publication.handled && !!presentation?.receipt && presentation.acknowledgedReceipt === presentation.receipt;
}
export function replaceOnboardingPresentation(receipt: string): OnboardingPresentation {
  return { receipt, acknowledgedReceipt: null };
}
export function acknowledgeOnboardingPresentation(presentation: OnboardingPresentation, actualReceipt: string): OnboardingPresentation {
  if (presentation.receipt !== actualReceipt) throw new Error('资源卡的确认已变化，请重新确认。');
  return { receipt: presentation.receipt, acknowledgedReceipt: actualReceipt };
}
