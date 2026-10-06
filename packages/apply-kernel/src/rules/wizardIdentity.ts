/**
 * Read-only interpretation of a v3 wizard declaration; v2 behavior is unchanged.
 * A parsed declaration is data, never write authority. This module does not
 * register a ruleset, fetch a bundle, navigate, or change a host control.
 */

import {
  parseExecutionRuntimeWizardDeclarationV1,
  type ExecutionRuntimeWizardDeclarationV1,
  type ExecutionRuntimeWizardDeclarationResult,
} from '@edaix/contracts/execution-wizard';

export type WizardReadOnlyDeclaration = ExecutionRuntimeWizardDeclarationV1;

export interface DeclaredWizardStep {
  readonly wizardKey: string;
  readonly stepKey: string;
  /** Index within this declaration; never a count of all application pages. */
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly applicationRoot: Element;
  readonly indicator: Element;
  readonly panel: Element;
}

type ReadResult = Readonly<{ ok: true; value: DeclaredWizardStep }> |
  Readonly<{ ok: false; code: 'PILOT_DISCOVERY_UNAVAILABLE' | 'PILOT_TARGET_DRIFT' }>;

const IDREF = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const trustedDeclarations = new WeakMap<object, string>();
const trustedSteps = new WeakMap<object, string>();

/** Kernel-local provenance for declarations decoded by the shared wire parser. */
export function parseWizardReadOnlyDeclaration(input: unknown): ExecutionRuntimeWizardDeclarationResult {
  const parsed = parseExecutionRuntimeWizardDeclarationV1(input);
  if (parsed.ok) trustedDeclarations.set(parsed.value, JSON.stringify(parsed.value));
  return parsed;
}

function unique(root: Document | Element, query: string): Element | null {
  const found = root.querySelectorAll(query);
  return found.length === 1 ? found[0]! : null;
}

function uniqueDocumentId(document: Document, id: string): Element | null {
  // Proving ID uniqueness includes nodes outside the application root. Bound
  // the full walk instead of treating getElementById's first hit as unique.
  const root = document.documentElement;
  if (root === null) return null;
  const walker = document.createTreeWalker(root, 1);
  let node: Node | null = root, found: Element | null = null, visited = 0;
  while (node !== null) {
    if (++visited > 4096) return null;
    const element = node as Element;
    if (element.getAttribute('id') === id) {
      if (found !== null) return null;
      found = element;
    }
    node = walker.nextNode();
  }
  return found;
}

function visibleInDocument(element: Element, document: Document, isVisible: (element: Element) => boolean): boolean {
  if (element.ownerDocument !== document || !element.isConnected || element.getRootNode() !== document ||
      isVisible(element) !== true) return false;
  let parent: Element | null = element;
  while (parent !== null) {
    if (parent.hasAttribute('hidden') || parent.hasAttribute('inert') || parent.getAttribute('aria-hidden') === 'true') return false;
    parent = parent.parentElement;
  }
  return true;
}

export function readDeclaredWizardStep(input: Readonly<{
  declaration: WizardReadOnlyDeclaration;
  document: Document;
  /** Existing DOM adapter owns computed visibility; a missing proof is false. */
  isVisible: (element: Element) => boolean;
}>): ReadResult {
  try {
    const fingerprint = trustedDeclarations.get(input.declaration);
    if (fingerprint === undefined) return { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' };
    const declaration = input.declaration, document = input.document;
    const root = unique(document, declaration.applicationRootSelector);
    if (root === null || !visibleInDocument(root, document, input.isVisible)) return { ok: false, code: 'PILOT_TARGET_DRIFT' };
    const container = unique(root, declaration.indicatorContainerSelector);
    if (container === null || !visibleInDocument(container, document, input.isVisible)) return { ok: false, code: 'PILOT_TARGET_DRIFT' };
    const indicators = declaration.steps.map((step) => unique(container, step.indicatorSelector));
    if (indicators.some((element) => element === null) || new Set(indicators).size !== indicators.length) {
      return { ok: false, code: 'PILOT_TARGET_DRIFT' };
    }
    const current = [...container.querySelectorAll('[aria-current]')].filter((element) => {
      const value = element.getAttribute('aria-current');
      return value !== null && value !== '' && value !== 'false';
    });
    if (current.length !== 1 || current[0]!.getAttribute('aria-current') !== 'step') return { ok: false, code: 'PILOT_TARGET_DRIFT' };
    const indicator = current[0]!, stepIndex = indicators.indexOf(indicator);
    if (stepIndex < 0 || !visibleInDocument(indicator, document, input.isVisible)) return { ok: false, code: 'PILOT_TARGET_DRIFT' };
    const controls = indicator.getAttribute('aria-controls');
    if (controls === null || !IDREF.test(controls)) return { ok: false, code: 'PILOT_TARGET_DRIFT' };
    const panel = uniqueDocumentId(document, controls);
    if (panel === null || panel === root || container.contains(panel) || !root.contains(panel) ||
        !visibleInDocument(panel, document, input.isVisible)) return { ok: false, code: 'PILOT_TARGET_DRIFT' };
    const value: DeclaredWizardStep = Object.freeze({
      wizardKey: declaration.wizardKey, stepKey: declaration.steps[stepIndex]!.stepKey,
      stepIndex, stepCount: declaration.steps.length, applicationRoot: root, indicator, panel,
    });
    trustedSteps.set(value, fingerprint);
    return Object.freeze({ ok: true, value });
  } catch { return { ok: false, code: 'PILOT_TARGET_DRIFT' }; }
}

/** Same rule and same live nodes, not merely the same text/key after replacement. */
export function sameDeclaredWizardStep(left: DeclaredWizardStep, right: DeclaredWizardStep): boolean {
  try {
    const fingerprint = trustedSteps.get(left);
    return fingerprint !== undefined && fingerprint === trustedSteps.get(right) &&
      left.wizardKey === right.wizardKey && left.stepKey === right.stepKey &&
      left.stepIndex === right.stepIndex && left.stepCount === right.stepCount &&
      left.applicationRoot === right.applicationRoot && left.indicator === right.indicator && left.panel === right.panel;
  } catch { return false; }
}

/** Two live step facts from the exact same parsed rule and application root. */
export function sameDeclaredWizardApplication(left: DeclaredWizardStep, right: DeclaredWizardStep): boolean {
  try {
    const fingerprint = trustedSteps.get(left);
    return fingerprint !== undefined && fingerprint === trustedSteps.get(right) &&
      left.applicationRoot === right.applicationRoot && left.wizardKey === right.wizardKey &&
      left.stepCount === right.stepCount;
  } catch { return false; }
}
