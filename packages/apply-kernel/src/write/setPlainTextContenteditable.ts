import type {
  PlainTextContenteditableAttestation,
  Result,
  ScanRoot,
} from '../contracts';
import { checkActiveCapability, type HostWriteAuthority } from '../grant';
import { fieldSignature } from '../fieldIdentity';
import {
  hasPlainTextOnlyStructure,
  isCurrentPlainTextContenteditableAttestation,
} from '../rules/plainTextContenteditable';
import { isRecordedPlainTextContenteditableTicket, type WriteTicket } from '../undo';
import { captureScanRootObservationTargets } from '../scanRoot';
import { dispatchHostEvent, EVENT_PROFILES } from './allowlist';
import { verifyWrittenValue } from './verify';

type PlainTextContenteditableWriteError =
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'CAPABILITY_DISABLED'
  | 'IDENTITY_CHANGED'
  | 'WRITE_REVERTED';

export interface PlainTextContenteditableWriteInput {
  readonly element: HTMLElement;
  readonly value: string;
  readonly root: ScanRoot;
  readonly attestation: PlainTextContenteditableAttestation;
  readonly authority: HostWriteAuthority;
  readonly ticket: WriteTicket;
}

function notifyHost(element: HTMLElement): void {
  for (const event of EVENT_PROFILES.richtext) dispatchHostEvent(element, event);
}

type Receipt =
  | { readonly kind: 'text'; readonly text: Text; readonly value: string }
  | { readonly kind: 'normalization'; readonly span: HTMLSpanElement; readonly text: Text };

interface Transaction {
  readonly ticket: WriteTicket;
  readonly element: HTMLElement;
  readonly document: Document;
  readonly root: ScanRoot;
  readonly attestation: PlainTextContenteditableAttestation;
  readonly signature: ReturnType<typeof fieldSignature>;
  readonly label: string;
  readonly targets: readonly Node[];
  readonly ancestors: readonly Node[];
  readonly attributes: readonly (readonly [string, string])[];
  readonly observer: MutationObserver;
  readonly onUserEdit: (event: Event) => void;
  /** No caller can supply a replacement snapshot: the sole preshape is []. */
  phase: 'recorded' | 'fill-events' | 'written' | 'restoring' | 'restored' | 'disposed';
  attempted: string | null;
  receipt: Receipt | null;
  dirty: boolean;
  userEditEpoch: number;
  restoreAttempted: boolean;
  settlement: Promise<boolean> | null;
}

// Journal-issued ticket -> private in-memory witness. No DOM, text, receipt or
// caller-supplied restoration value is exported from this module.
const transactions = new WeakMap<WriteTicket, Transaction>();
const EDIT_EVENTS = [
  'beforeinput', 'input', 'change', 'compositionstart', 'compositionupdate',
  'compositionend', 'paste', 'drop', 'cut',
] as const;

function sameNodes(left: readonly Node[], right: readonly Node[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function ancestorsOf(element: HTMLElement): readonly Node[] {
  const ancestors: Node[] = [];
  let node: Node | null = element.parentNode;
  while (node) {
    ancestors.push(node);
    node = node.parentNode ?? (node as Partial<ShadowRoot>).host ?? null;
  }
  return ancestors;
}

function attributesOf(element: HTMLElement): readonly (readonly [string, string])[] {
  return [...element.attributes].map((attribute) => [attribute.name, attribute.value] as const);
}

function identityIsCurrent(transaction: Transaction): boolean {
  const { element, root, attestation } = transaction;
  try {
    const targets = captureScanRootObservationTargets(root);
    const signature = fieldSignature(element, root);
    const attributes = attributesOf(element);
    return !transaction.dirty && transaction.userEditEpoch === 0 &&
      transaction.phase !== 'disposed' &&
      element.ownerDocument === transaction.document && element.isConnected &&
      targets !== null && sameNodes(targets, transaction.targets) &&
      sameNodes(ancestorsOf(element), transaction.ancestors) &&
      attributes.length === transaction.attributes.length &&
      attributes.every(([name, value], index) =>
        name === transaction.attributes[index]?.[0] && value === transaction.attributes[index]?.[1]) &&
      signature.core === transaction.signature.core &&
      signature.labelHint === transaction.signature.labelHint &&
      root.labelTextFor(element) === transaction.label &&
      isCurrentPlainTextContenteditableAttestation({
        attestation, root, element, purpose: 'fill',
      });
  } catch {
    return false;
  }
}

function receiptIsCurrent(transaction: Transaction): boolean {
  try {
    const { element, receipt } = transaction;
    if (!receipt || element.childNodes.length !== 1) return false;
    if (receipt.kind === 'text') {
      return element.firstChild === receipt.text && receipt.text.data === receipt.value;
    }
    // One inert, attribute-free HTML span around one exact Text node is the
    // only normalization receipt. This is not admission for structured editors.
    return element.firstChild === receipt.span && receipt.span.attributes.length === 0 &&
      receipt.span.shadowRoot === null && receipt.span.childNodes.length === 1 &&
      receipt.span.firstChild === receipt.text && receipt.text.data === transaction.attempted &&
      element.textContent === transaction.attempted;
  } catch {
    // A host accessor error is neither evidence nor a safe diagnostic value.
    // Permanently invalidate this witness instead of rebaselining on retry.
    transaction.dirty = true;
    return false;
  }
}

function consumeMutations(transaction: Transaction, records: readonly MutationRecord[]): void {
  if (transaction.dirty || transaction.phase === 'disposed') return;
  // A hostile observer flood cannot acquire an unbounded snapshot or receipt.
  if (records.length > 128) { transaction.dirty = true; return; }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const { element, receipt } = transaction;
    if (record.type === 'childList' && transaction.ancestors.includes(record.target) &&
      !transaction.targets.some((target) => target === record.target || target.contains(record.target))) {
      // Ancestors are observed only to prove the original attachment path.
      // An unrelated sibling (including our closed-Shadow audit surface)
      // outside the trusted form cannot alter its container-scoped identity.
      const path = [element, ...transaction.ancestors];
      if (![...record.addedNodes, ...record.removedNodes].some((node) => path.includes(node))) continue;
    }
    if (record.type === 'childList' && record.target === element && receipt?.kind === 'text') {
      // A single replace operation may be delivered as one combined record
      // or an adjacent remove/add pair. Never join records across deliveries.
      const next = records[index + 1];
      const splitReplacement = record.removedNodes.length === 1 && record.addedNodes.length === 0 &&
        next?.type === 'childList' && next.target === element &&
        next.removedNodes.length === 0 && next.addedNodes.length === 1;
      const additions = splitReplacement ? next!.addedNodes : record.addedNodes;
      const added = additions[0];
      if (
        record.removedNodes.length === 1 && record.removedNodes[0] === receipt.text &&
        additions.length === 1 && added === element.firstChild
      ) {
        if (
          (transaction.phase === 'fill-events' || transaction.phase === 'written') &&
          receipt.value === transaction.attempted &&
          added instanceof HTMLSpanElement &&
          added.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
          added.attributes.length === 0 && added.shadowRoot === null &&
          added.childNodes.length === 1 && added.firstChild instanceof Text &&
          added.firstChild.data === transaction.attempted
        ) {
          transaction.receipt = { kind: 'normalization', span: added, text: added.firstChild };
          if (splitReplacement) index += 1;
          continue;
        }
        // Preserve the existing synchronous plain-text compensation path.
        // A later value change is not attributable to that event transaction.
        if (transaction.phase === 'fill-events' && added instanceof Text &&
          element.childNodes.length === 1) {
          transaction.receipt = { kind: 'text', text: added, value: added.data };
          if (splitReplacement) index += 1;
          continue;
        }
      }
    }
    // Observe detach+reattach and edit+edit-back, not just the final equality.
    // Outside the target, any observed scope/identity mutation is unsupported;
    // it must never be mistaken for normalization owned by this transaction.
    transaction.dirty = true;
  }
  if (!identityIsCurrent(transaction)) transaction.dirty = true;
}

function flush(transaction: Transaction): void {
  consumeMutations(transaction, transaction.observer.takeRecords());
}

/** Called only while the journal registers a genuine new, exact-empty ticket. */
export function sealPlainTextContenteditableTicket(
  ticket: WriteTicket,
  element: HTMLElement,
  root: ScanRoot,
  attestation: PlainTextContenteditableAttestation,
): boolean {
  if (!isRecordedPlainTextContenteditableTicket(ticket, element, root, attestation) || transactions.has(ticket) ||
    element.childNodes.length !== 0 || element.textContent !== '' ||
    !isCurrentPlainTextContenteditableAttestation({ attestation, root, element, purpose: 'fill' })) {
    return false;
  }
  const targets = captureScanRootObservationTargets(root);
  if (!targets || typeof MutationObserver !== 'function') return false;
  let transaction: Transaction;
  const observer = new MutationObserver((records) => consumeMutations(transaction, records));
  const onUserEdit = (event: Event) => {
    if (event.isTrusted) transaction.userEditEpoch += 1;
  };
  try {
    transaction = {
      ticket, element, document: element.ownerDocument, root, attestation,
      signature: fieldSignature(element, root), label: root.labelTextFor(element),
      targets, ancestors: ancestorsOf(element), attributes: attributesOf(element),
      observer, onUserEdit, phase: 'recorded', attempted: null, receipt: null,
      dirty: false, userEditEpoch: 0, restoreAttempted: false, settlement: null,
    };
    for (const target of targets) observer.observe(target, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    for (const ancestor of transaction.ancestors) {
      if (!targets.includes(ancestor)) observer.observe(ancestor, { childList: true, attributes: true });
    }
    for (const type of EDIT_EVENTS) element.addEventListener(type, onUserEdit, true);
    transactions.set(ticket, transaction);
    return true;
  } catch {
    observer.disconnect();
    for (const type of EDIT_EVENTS) element.removeEventListener(type, onUserEdit, true);
    return false;
  }
}

export function forgetPlainTextContenteditableTicket(ticket: WriteTicket): void {
  const transaction = transactions.get(ticket);
  if (!transaction) return;
  transaction.phase = 'disposed';
  transaction.observer.disconnect();
  for (const type of EDIT_EVENTS) transaction.element.removeEventListener(type, transaction.onUserEdit, true);
  transactions.delete(ticket);
}

function exactEmptyReadback(transaction: Transaction): boolean {
  try {
    flush(transaction);
    const held = identityIsCurrent(transaction) && transaction.phase === 'restored' &&
      transaction.element.childNodes.length === 0 && transaction.element.textContent === '';
    if (transaction.observer.takeRecords().length !== 0) transaction.dirty = true;
    return held && !transaction.dirty && transaction.userEditEpoch === 0;
  } catch {
    transaction.dirty = true;
    return false;
  }
}

/** Read-only finalization guard, including the microtask after settled readback. */
export function hasExactPlainTextContenteditableRestoration(ticket: WriteTicket): boolean {
  const transaction = transactions.get(ticket);
  return transaction !== undefined && exactEmptyReadback(transaction);
}

export function hasPlainTextContenteditableWriteAttempt(ticket: WriteTicket): boolean {
  return transactions.get(ticket)?.attempted != null;
}

/** Read-only settlement; it never performs delayed compensation. */
export async function settledPlainTextContenteditableRestoration(ticket: WriteTicket): Promise<boolean> {
  const transaction = transactions.get(ticket);
  return transaction !== undefined && transaction.settlement !== null &&
    await transaction.settlement && transactions.get(ticket) === transaction &&
    exactEmptyReadback(transaction);
}

// The sole structural compensator. Its only destination is the privately
// sealed empty preshape. There is no HTML, node, markup or value parameter.
function restoreSealedEmpty(
  transaction: Transaction,
  authority: HostWriteAuthority,
): Result<Promise<boolean>, PlainTextContenteditableWriteError> {
  flush(transaction);
  if (transaction.restoreAttempted || !identityIsCurrent(transaction) ||
    !receiptIsCurrent(transaction)) return { ok: false, code: 'IDENTITY_CHANGED' };
  const access = checkActiveCapability(authority, 'set-richtext');
  if (!access.ok) return access;
  // Recheck after every potentially hostile DOM/rule read and immediately
  // before the setter. A normalization requires the exact attempted text.
  flush(transaction);
  if (!identityIsCurrent(transaction) || !receiptIsCurrent(transaction)) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  let previousNode: ChildNode | null;
  try {
    previousNode = transaction.element.firstChild;
  } catch {
    transaction.dirty = true;
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  // Validation itself may invoke a host accessor. Do not let a last-moment
  // mutation or trusted event (even during the removal snapshot read above)
  // hide behind the earlier identity snapshot.
  if (transaction.observer.takeRecords().length !== 0 || transaction.userEditEpoch !== 0) {
    transaction.dirty = true;
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  const finalAccess = checkActiveCapability(authority, 'set-richtext');
  if (!finalAccess.ok) return finalAccess;
  transaction.restoreAttempted = true;
  transaction.phase = 'restoring';
  try {
    transaction.element.textContent = '';
    const ownRecords = transaction.observer.takeRecords();
    if (ownRecords.length !== 1 || ownRecords[0]?.type !== 'childList' ||
      ownRecords[0].target !== transaction.element || ownRecords[0].addedNodes.length !== 0 ||
      ownRecords[0].removedNodes.length !== 1 || ownRecords[0].removedNodes[0] !== previousNode) {
      transaction.dirty = true;
    }
    transaction.phase = 'restored';
    notifyHost(transaction.element);
    flush(transaction);
  } catch {
    transaction.dirty = true;
    return { ok: false, code: 'WRITE_REVERTED' };
  }
  // No setter is reachable from this promise. Failure keeps the journal and
  // cannot rebaseline a future erasure capability over the host's new state.
  transaction.settlement = verifyWrittenValue({
    expected: '', previous: transaction.attempted ?? '', exact: true,
    readCurrent: () => transaction.element.textContent ?? '',
    currentIsValid: () => exactEmptyReadback(transaction),
  }).then((result) => result === 'ok', () => false);
  return { ok: true, value: transaction.settlement };
}

/** Explicit Undo accepts only the original journal ticket and fresh authority. */
export function restorePlainTextContenteditableTicket(
  ticket: WriteTicket,
  authority: HostWriteAuthority,
): Result<Promise<boolean>, PlainTextContenteditableWriteError> {
  const transaction = transactions.get(ticket);
  if (!transaction || !isRecordedPlainTextContenteditableTicket(
    ticket, transaction.element, transaction.root, transaction.attestation,
  ) || authority.purpose !== 'undo') {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  return restoreSealedEmpty(transaction, authority);
}

/** The only primitive allowed to set a reviewed plain-text contenteditable. */
export function setPlainTextContenteditable(
  input: PlainTextContenteditableWriteInput,
): Result<string, PlainTextContenteditableWriteError> {
  const { element, value, authority } = input;
  const access = checkActiveCapability(authority, 'set-richtext');
  if (!access.ok) return access;
  const transaction = transactions.get(input.ticket);
  if (!transaction || !isRecordedPlainTextContenteditableTicket(
    input.ticket, element, input.root, input.attestation,
  ) || authority.purpose !== 'fill' ||
    transaction.phase !== 'recorded' || transaction.element !== element ||
    transaction.root !== input.root || transaction.attestation !== input.attestation) {
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  flush(transaction);
  if (!identityIsCurrent(transaction) || element.childNodes.length !== 0 ||
    element.textContent !== '' || value.length === 0) return { ok: false, code: 'WRITE_REVERTED' };
  if (transaction.observer.takeRecords().length !== 0 || transaction.userEditEpoch !== 0) {
    transaction.dirty = true;
    return { ok: false, code: 'IDENTITY_CHANGED' };
  }
  const finalAccess = checkActiveCapability(authority, 'set-richtext');
  if (!finalAccess.ok) return finalAccess;
  transaction.attempted = value;
  transaction.phase = 'fill-events';

  try {
    element.textContent = value;
    const text = element.firstChild;
    const ownRecords = transaction.observer.takeRecords();
    if (!(text instanceof Text) || text.data !== value || [...element.childNodes].length !== 1 ||
      ownRecords.length !== 1 || ownRecords[0]?.type !== 'childList' ||
      ownRecords[0].target !== element || ownRecords[0].removedNodes.length !== 0 ||
      ownRecords[0].addedNodes.length !== 1 || ownRecords[0].addedNodes[0] !== text) {
      transaction.dirty = true;
      return { ok: false, code: 'WRITE_REVERTED' };
    }
    transaction.receipt = { kind: 'text', text, value };
    notifyHost(element);
    flush(transaction);
  } catch {
    flush(transaction);
    restoreSealedEmpty(transaction, authority);
    return { ok: false, code: 'WRITE_REVERTED' };
  }
  transaction.phase = 'written';
  if (!identityIsCurrent(transaction) || !hasPlainTextOnlyStructure(element) ||
    element.textContent !== value) {
    // Only the still-active fill authority can compensate synchronously.
    // C6 and late readback never call this private setter.
    restoreSealedEmpty(transaction, authority);
    return { ok: false, code: 'WRITE_REVERTED' };
  }
  return { ok: true, value };
}
