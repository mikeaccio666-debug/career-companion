import {
  parseSensitiveStatementTextV1,
  parseUuid,
  type SensitiveStatementTextV1,
  type Uuid,
} from '@edaix/contracts';
import type { PendingL2pSensitiveAssistedWriteClass } from '@edaix/contracts/draft';
import { isTrustedShadowGesture } from '@edaix/apply-kernel/grant';

type PendingSensitiveLegalProposalClass = Exclude<
  PendingL2pSensitiveAssistedWriteClass,
  'PASSWORD'
>;

export interface PendingSensitiveLegalPromptItem {
  readonly kind: 'LEGAL_AUTHORIZATION';
  readonly proposalClass: PendingSensitiveLegalProposalClass;
  /** Local UI identity only; never a backend confirmation identifier. */
  readonly promptItemId: string;
  readonly statementText: string;
}

export interface PendingSensitivePasswordPromptItem {
  readonly kind: 'PASSWORD';
  readonly proposalClass: 'PASSWORD';
  /** Local UI identity only; never a backend confirmation identifier. */
  readonly promptItemId: string;
  readonly canonicalOrigin: string;
}

export type PendingSensitiveReleasePromptItem =
  | PendingSensitiveLegalPromptItem
  | PendingSensitivePasswordPromptItem;

export type PendingSensitiveReleaseDecision = 'RELEASE' | 'HANDLE_MANUALLY';

export type PendingSensitiveReleaseDecisionItem = Readonly<{
  promptItemId: Uuid;
  decision: PendingSensitiveReleaseDecision;
}>;

export type PendingSensitiveReleasePromptDecision =
  | Readonly<{
      kind: 'DECIDED';
      items: readonly PendingSensitiveReleaseDecisionItem[];
    }>
  | Readonly<{
      kind: 'CANCELLED';
      reason:
        | 'INVALID_ITEMS'
        | 'POLICY_DISABLED'
        | 'USER_CANCELLED'
        | 'PAGE_UNLOADED'
        | 'HOST_REMOVED';
    }>;

export interface PendingSensitiveReleasePrompt {
  readonly decision: Promise<PendingSensitiveReleasePromptDecision>;
  readonly dismiss: () => void;
  readonly root: ShadowRoot | null;
}

type NormalizedLegalItem = Readonly<{
  kind: 'LEGAL_AUTHORIZATION';
  proposalClass: PendingSensitiveLegalProposalClass;
  promptItemId: Uuid;
  statementText: SensitiveStatementTextV1;
}>;
type NormalizedPasswordItem = Readonly<{
  kind: 'PASSWORD';
  proposalClass: 'PASSWORD';
  promptItemId: Uuid;
  canonicalOrigin: string;
}>;
type NormalizedItem = NormalizedLegalItem | NormalizedPasswordItem;

const HOST_ID = 'edaix-sensitive-release-prompt';
const LEGAL_CLASSES = new Set<string>([
  'BACKGROUND_CHECK_AUTHORIZATION',
  'ARBITRATION_AGREEMENT',
  'CREDIT_REPORT_AUTHORIZATION',
  'DRUG_TEST_AUTHORIZATION',
]);
let dismissCurrent: (() => void) | null = null;

const CSS = `
:host { all: initial; }
.panel { position:fixed; right:16px; bottom:16px; z-index:2147483647; width:min(520px,calc(100vw - 32px)); max-height:min(80vh,680px); overflow:auto; padding:16px; border-radius:12px; background:#12121c; color:#f6f7fb; font:14px/1.5 system-ui,sans-serif; box-shadow:0 10px 36px rgba(0,0,0,.5); }
.title { font-size:16px; margin:0 0 4px; }
.note { color:#b9b9cc; margin:0 0 12px; }
.row { border:1px solid rgba(255,255,255,.16); margin:0 0 10px; padding:10px; }
.choice { display:block; margin-top:8px; }
button { border:0; border-radius:6px; padding:8px 12px; background:#33334d; color:#fff; cursor:pointer; }
button + button { margin-left:8px; }
button:focus-visible, input:focus-visible { outline:2px solid #8ab4ff; outline-offset:2px; }
button[disabled] { opacity:.5; cursor:default; }
`;

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCanonicalHttpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.origin === value &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

function normalizeItems(value: unknown): readonly NormalizedItem[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const normalized: NormalizedItem[] = [];
  const ids = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    if ((item as { kind?: unknown }).kind === 'LEGAL_AUTHORIZATION') {
      if (!isExactRecord(item, [
        'kind',
        'proposalClass',
        'promptItemId',
        'statementText',
      ])) return null;
      const promptItemId = parseUuid(item.promptItemId);
      const statementText = parseSensitiveStatementTextV1(item.statementText);
      if (
        promptItemId === null ||
        statementText === null ||
        !LEGAL_CLASSES.has(String(item.proposalClass)) ||
        ids.has(promptItemId)
      ) return null;
      ids.add(promptItemId);
      normalized.push(Object.freeze({
        kind: 'LEGAL_AUTHORIZATION',
        proposalClass: item.proposalClass as PendingSensitiveLegalProposalClass,
        promptItemId,
        statementText,
      }));
      continue;
    }

    if (!isExactRecord(item, [
      'kind',
      'proposalClass',
      'promptItemId',
      'canonicalOrigin',
    ]) || item.kind !== 'PASSWORD' || item.proposalClass !== 'PASSWORD') return null;
    const promptItemId = parseUuid(item.promptItemId);
    const canonicalOrigin = parseCanonicalHttpsOrigin(item.canonicalOrigin);
    if (
      promptItemId === null ||
      canonicalOrigin === null ||
      ids.has(promptItemId)
    ) return null;
    ids.add(promptItemId);
    normalized.push(Object.freeze({
      kind: 'PASSWORD',
      proposalClass: 'PASSWORD',
      promptItemId,
      canonicalOrigin,
    }));
  }
  return Object.freeze(normalized);
}

export function cancelledPendingSensitiveReleasePrompt(
  reason: Extract<PendingSensitiveReleasePromptDecision, { kind: 'CANCELLED' }>['reason'],
): PendingSensitiveReleasePrompt {
  return Object.freeze({
    decision: Promise.resolve<PendingSensitiveReleasePromptDecision>({
      kind: 'CANCELLED',
      reason,
    }),
    dismiss: () => undefined,
    root: null,
  });
}

function decisionItem(
  item: NormalizedItem,
  decision: PendingSensitiveReleaseDecision,
): PendingSensitiveReleaseDecisionItem {
  return Object.freeze({ promptItemId: item.promptItemId, decision });
}

/**
 * Draft-only renderer. Production entrypoints must use the gated facade in
 * sensitiveReleasePrompt.ts; an import-graph regression enforces that rule.
 */
export function showPendingSensitiveReleasePromptDraft(
  untrustedItems: readonly PendingSensitiveReleasePromptItem[],
  doc: Document = document,
): PendingSensitiveReleasePrompt {
  const items = normalizeItems(untrustedItems);
  if (items === null || doc.documentElement === null || doc.body === null) {
    return cancelledPendingSensitiveReleasePrompt('INVALID_ITEMS');
  }

  dismissCurrent?.();
  const host = doc.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = doc.createElement('style');
  sheet.textContent = CSS;
  const panel = doc.createElement('section');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Review sensitive application items');

  const title = doc.createElement('h2');
  title.className = 'title';
  title.textContent = 'Confirm each sensitive item before writing';
  const note = doc.createElement('p');
  note.className = 'note';
  note.textContent = 'No item is selected by default. You can handle any item manually.';
  panel.append(title, note);

  const decisions = new Map<Uuid, PendingSensitiveReleaseDecision>();
  const decisionInputs = new Map<Uuid, Map<PendingSensitiveReleaseDecision, HTMLInputElement>>();
  const submit = doc.createElement('button');
  submit.type = 'button';
  submit.dataset.action = 'submit';
  submit.textContent = 'Continue with explicit decisions';
  submit.disabled = true;

  const updateSubmit = (): void => {
    submit.disabled = decisions.size !== items.length;
  };

  for (const item of items) {
    const row = doc.createElement('fieldset');
    row.className = 'row';
    const statement = doc.createElement('legend');
    statement.textContent = item.kind === 'LEGAL_AUTHORIZATION'
      ? item.statementText
      : `Password stored locally for ${item.canonicalOrigin}`;
    row.append(statement);
    const inputs = new Map<PendingSensitiveReleaseDecision, HTMLInputElement>();

    for (const decision of ['RELEASE', 'HANDLE_MANUALLY'] as const) {
      const label = doc.createElement('label');
      label.className = 'choice';
      const radio = doc.createElement('input');
      radio.type = 'radio';
      radio.name = `sensitive-release-${item.promptItemId}`;
      radio.value = decision;
      inputs.set(decision, radio);
      radio.addEventListener('change', (event) => {
        if (!radio.checked || !isTrustedShadowGesture(event, root)) return;
        decisions.set(item.promptItemId, decision);
        updateSubmit();
      });
      label.append(
        radio,
        doc.createTextNode(
          decision === 'RELEASE'
            ? ' Allow this one assisted write'
            : ' I will handle this manually',
        ),
      );
      row.append(label);
    }
    decisionInputs.set(item.promptItemId, inputs);
    panel.append(row);
  }

  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  panel.append(submit, cancel);
  root.append(sheet, panel);
  doc.body.append(host);

  let resolveDecision: (value: PendingSensitiveReleasePromptDecision) => void = () => undefined;
  const decision = new Promise<PendingSensitiveReleasePromptDecision>((resolve) => {
    resolveDecision = resolve;
  });
  let settled = false;
  let observer: MutationObserver | null = null;

  const finish = (result: PendingSensitiveReleasePromptDecision): void => {
    if (settled) return;
    settled = true;
    observer?.disconnect();
    doc.defaultView?.removeEventListener('pagehide', onPageHide);
    host.remove();
    if (dismissCurrent === dismiss) dismissCurrent = null;
    resolveDecision(result);
  };
  const dismiss = (): void => finish({ kind: 'CANCELLED', reason: 'USER_CANCELLED' });
  const onPageHide = (): void => finish({ kind: 'CANCELLED', reason: 'PAGE_UNLOADED' });

  submit.addEventListener('click', (event) => {
    if (!isTrustedShadowGesture(event, root) || decisions.size !== items.length) return;
    for (const item of items) {
      const selected = decisions.get(item.promptItemId);
      const inputs = decisionInputs.get(item.promptItemId);
      if (
        selected === undefined ||
        inputs?.get(selected)?.checked !== true ||
        [...(inputs?.entries() ?? [])].some(
          ([candidate, input]) => candidate !== selected && input.checked,
        )
      ) return;
    }
    finish(Object.freeze({
      kind: 'DECIDED',
      items: Object.freeze(items.map((item) =>
        decisionItem(item, decisions.get(item.promptItemId)!),
      )),
    }));
  });
  cancel.addEventListener('click', dismiss);
  doc.defaultView?.addEventListener('pagehide', onPageHide, { once: true });
  const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
  observer = new Observer(() => {
    if (!host.isConnected) finish({ kind: 'CANCELLED', reason: 'HOST_REMOVED' });
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  dismissCurrent = dismiss;

  return Object.freeze({ decision, dismiss, root });
}
