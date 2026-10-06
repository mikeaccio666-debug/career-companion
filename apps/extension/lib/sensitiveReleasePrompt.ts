import type { ResolvedContentRuntimeAuthority } from './executionRuntimeAuthority';
import {
  cancelledPendingSensitiveReleasePrompt,
  showPendingSensitiveReleasePromptDraft,
  type PendingSensitiveReleasePrompt,
  type PendingSensitiveReleasePromptItem,
} from './sensitiveReleasePromptDraft';

export type {
  PendingSensitiveLegalPromptItem,
  PendingSensitivePasswordPromptItem,
  PendingSensitiveReleaseDecision,
  PendingSensitiveReleaseDecisionItem,
  PendingSensitiveReleasePrompt,
  PendingSensitiveReleasePromptDecision,
  PendingSensitiveReleasePromptItem,
} from './sensitiveReleasePromptDraft';

export interface PendingSensitiveOperatorGates {
  readonly releaseEnabled: boolean;
  readonly statementTransitEnabled: boolean;
}

/** PR #77 is a pending predecessor, not a production convergence. */
const SENSITIVE_PROMPT_RUNTIME_CONVERGED = false;

/**
 * Only production facade. It stays structurally unreachable until the same
 * final convergence supplies durable release, official-client registration,
 * fresh revalidation and an origin-bound local credential protocol.
 */
export function showPendingSensitiveReleasePrompt(input: Readonly<{
  items: readonly PendingSensitiveReleasePromptItem[];
  runtimeAuthority: ResolvedContentRuntimeAuthority;
  operatorGates: PendingSensitiveOperatorGates;
  document?: Document;
}>): PendingSensitiveReleasePrompt {
  if (
    !SENSITIVE_PROMPT_RUNTIME_CONVERGED ||
    !input.operatorGates.releaseEnabled ||
    !input.operatorGates.statementTransitEnabled ||
    !input.runtimeAuthority.allowedActions.includes('DISCOVER_SENSITIVE') ||
    !input.runtimeAuthority.allowedActions.includes('FILL_SENSITIVE') ||
    input.runtimeAuthority.policy.capabilities['set-attestation'] !== true
  ) {
    return cancelledPendingSensitiveReleasePrompt('POLICY_DISABLED');
  }
  return showPendingSensitiveReleasePromptDraft(input.items, input.document);
}
