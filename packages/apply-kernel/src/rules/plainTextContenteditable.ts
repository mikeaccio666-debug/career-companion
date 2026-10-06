import type {
  PlainTextContenteditableAttestation,
  ScanRoot,
} from '../contracts.ts';
import { isContentEditable } from '../dict/controls.ts';
import type { RuleMapAttr } from './schema.ts';

interface CreateAttestationInput {
  readonly root: ScanRoot;
  readonly element: HTMLElement;
  readonly attr: RuleMapAttr;
  readonly expectedValue: string;
}

const trustedAttestations = new WeakSet<object>();

function directAttributeValue(element: Element, attr: RuleMapAttr): string {
  return (element.getAttribute(attr) ?? '').toLowerCase();
}

function exactRuleTarget(
  root: ScanRoot,
  element: HTMLElement,
  attr: RuleMapAttr,
  expectedValue: string,
): boolean {
  if (expectedValue.length === 0 || !element.hasAttribute(attr)) return false;
  let matches: readonly Element[];
  try {
    matches = root.querySelectorAll('[contenteditable]').filter(
      (candidate) => candidate.hasAttribute(attr) &&
        directAttributeValue(candidate, attr) === expectedValue,
    );
  } catch {
    return false;
  }
  return matches.length === 1 &&
    matches[0] === element &&
    element.isConnected &&
    !root.isExcluded(element) &&
    isContentEditable(element);
}

function remainsWithinTrustedRoot(root: ScanRoot, element: HTMLElement): boolean {
  try {
    return root.querySelectorAll('*').includes(element) && !root.isExcluded(element);
  } catch {
    return false;
  }
}

/** Only an empty node or one Text node is a plain-text structure. */
export function hasPlainTextOnlyStructure(element: HTMLElement): boolean {
  if (element.childElementCount !== 0 || element.childNodes.length > 1) return false;
  const child = element.childNodes[0];
  return child === undefined || child.nodeType === Node.TEXT_NODE;
}

export function createPlainTextContenteditableAttestation(
  input: CreateAttestationInput,
): PlainTextContenteditableAttestation | null {
  const { root, element, attr, expectedValue } = input;
  if (
    !exactRuleTarget(root, element, attr, expectedValue) ||
    !hasPlainTextOnlyStructure(element)
  ) return null;

  const attestation = Object.freeze({
    source: 'trusted-apply-rule' as const,
    purpose: 'cover-letter' as const,
    isCurrent(
      candidateRoot: ScanRoot,
      candidateElement: HTMLElement,
      purpose: 'fill' | 'undo',
    ): boolean {
      if (
        candidateRoot !== root ||
        candidateElement !== element ||
        !candidateElement.isConnected
      ) return false;
      // Undo is bound to this exact in-memory node and a journaled exact value.
      // It may restore after the host merely revokes editing, but never after
      // the node leaves the original trusted ScanRoot or becomes excluded.
      return purpose === 'undo'
        ? remainsWithinTrustedRoot(root, element)
        : exactRuleTarget(root, element, attr, expectedValue);
    },
  });
  trustedAttestations.add(attestation);
  return attestation;
}

export function isCurrentPlainTextContenteditableAttestation(input: {
  readonly attestation: PlainTextContenteditableAttestation;
  readonly root: ScanRoot;
  readonly element: HTMLElement;
  readonly purpose: 'fill' | 'undo';
}): boolean {
  const { attestation } = input;
  return typeof attestation === 'object' &&
    attestation !== null &&
    trustedAttestations.has(attestation) &&
    attestation.source === 'trusted-apply-rule' &&
    attestation.purpose === 'cover-letter' &&
    attestation.isCurrent(input.root, input.element, input.purpose);
}
