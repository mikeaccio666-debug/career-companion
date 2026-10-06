/**
 * The single writer-admission mapping: which writer kind a compiled control maps
 * to, whether a classification may reach that writer, and the terminal UA-4
 * mints for a question no writer can take.
 *
 * It lives here, next to the kinds it maps, rather than inside the writer,
 * because both the writer and the UA-5 composition port need it and the port is
 * consumed by the backend. Importing it from the writer would drag the writer's
 * browser-side dependencies into a Node compilation; duplicating it would make
 * two authorities for one fact. Pure, no imports beyond types.
 */

import type {
  PilotUa4ControlKind,
  PilotUa4FinalDisposition,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';
import type { LogicalControlKind, QuestionClassification } from './ir.ts';

export function writerKind(kind: LogicalControlKind): PilotUa4ControlKind | null {
  switch (kind) {
    case 'TEXT_SINGLE': return 'TEXT';
    case 'TEXT_MULTILINE': return 'TEXTAREA';
    case 'TEXT_RICH': return 'CONTENTEDITABLE';
    case 'SELECT_ONE':
    case 'SELECT_MANY': return 'NATIVE_SELECT';
    case 'COMBOBOX': return 'COMBOBOX';
    case 'RADIO_GROUP': return 'RADIO_GROUP';
    case 'CHECKBOX_GROUP':
    case 'CHECKBOX_SINGLE':
    case 'SWITCH': return 'CHECKBOX_GROUP';
    case 'DATE': return 'DATE';
    case 'FILE': return 'FILE';
    default: return null;
  }
}

/** Whether a classification may be handed to a writer of this kind at all. */
export function classificationMatchesWriter(
  classification: QuestionClassification,
  kind: PilotUa4ControlKind,
): boolean {
  switch (classification.kind) {
    case 'CANONICAL_FIELD': return [
      'TEXT', 'TEXTAREA', 'CONTENTEDITABLE', 'NATIVE_SELECT', 'COMBOBOX',
      'RADIO_GROUP', 'CHECKBOX_GROUP', 'DATE',
    ].includes(kind);
    case 'STRUCTURED_CHOICE': return [
      'NATIVE_SELECT', 'COMBOBOX', 'RADIO_GROUP', 'CHECKBOX_GROUP',
    ].includes(kind);
    case 'STRUCTURED_DATE': return kind === 'DATE';
    case 'STRUCTURED_NUMBER': return kind === 'TEXT';
    case 'STRUCTURED_FILE': return kind === 'FILE';
    case 'OPEN_QUESTION': return ['TEXT', 'TEXTAREA', 'CONTENTEDITABLE'].includes(kind);
    case 'HUMAN_ACTION_REQUIRED':
    case 'UNRESOLVED': return false;
  }
}

/**
 * The terminal a question takes from its classification alone, or null when the
 * question is admissible and its terminal therefore depends on an authority.
 *
 * Null is load-bearing in both directions: UA-4's prepare step neither mints a
 * disposition nor asks the host to execute such a question, so whoever composes
 * the run has to account for it or the ledger is short a row. Both callers read
 * this one function so the two can never drift apart.
 */
export function classificationTerminalDisposition(
  classification: QuestionClassification | null,
  kind: PilotUa4ControlKind | null,
): PilotUa4FinalDisposition | null {
  if (
    classification === null ||
    classification.merge === 'CLASSIFICATION_CONFLICT' ||
    classification.merge === 'MEMBER_UNCLASSIFIED' ||
    classification.kind === 'UNRESOLVED' ||
    classification.duplicateRootStem
  ) return Object.freeze({
    state: 'USER_CONFIRMATION_REQUIRED' as const,
    reason: 'ANSWER_AUTHORITY_MISSING' as const,
  });
  if (classification.stemGuard === 'OTHER_PERSON') {
    return Object.freeze({ state: 'MANUAL_REQUIRED' as const, reason: 'OTHER_PERSON' as const });
  }
  if (classification.stemGuard !== 'NONE') {
    return Object.freeze({
      state: 'USER_CONFIRMATION_REQUIRED' as const,
      reason: 'SENSITIVE_CONFIRMATION' as const,
    });
  }
  if (classification.kind === 'HUMAN_ACTION_REQUIRED') {
    const reasons = new Set(classification.members.map((member) => member.reasonCode));
    const reason = reasons.size === 1 && reasons.has('HUMAN_PASSWORD_CONTROL')
      ? 'PASSWORD' as const
      : reasons.size === 1 && reasons.has('HUMAN_SUBMIT_CONTROL')
        ? 'FINAL_SUBMIT' as const
        : 'HUMAN_ACTION' as const;
    return Object.freeze({ state: 'MANUAL_REQUIRED' as const, reason });
  }
  if (kind === null || !classificationMatchesWriter(classification, kind)) {
    return Object.freeze({
      state: 'USER_CONFIRMATION_REQUIRED' as const,
      reason: 'ANSWER_AUTHORITY_MISSING' as const,
    });
  }
  return null;
}
