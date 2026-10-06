import greenhouseCanary from '../../packages/apply-rules/rules/greenhouse-controlled-combobox-canary.json';

import { buildApplyPlan } from '../../packages/apply-kernel/src/engine';
import { mintAuthority } from '../../packages/apply-kernel/src/grant';
import { createBundledApplyPolicy } from '../../packages/apply-kernel/src/policy';
import { compileBundledAdapter } from '../../packages/apply-kernel/src/rules/interpreter';
import { runApplyPlan } from '../../packages/apply-kernel/src/runner';
import { createUndoJournal } from '../../packages/apply-kernel/src/undo';

export interface ControlledComboboxInput {
  readonly event: Event;
  readonly shadowRoot: ShadowRoot;
  readonly form: HTMLFormElement;
  readonly trigger: HTMLInputElement;
  readonly desired: string;
}

/**
 * Real-browser controlled harness only. The sole DOM descriptor comes from a
 * never-exported synthetic apply-rules JSON. This exercises the production
 * runner, semantic late recheck and journal Undo, but no Extension, Mission,
 * remote runtime or real posting; its result is value-free NON_ACCEPTANCE.
 */
export async function runControlledCombobox(input: ControlledComboboxInput) {
  const adapter = compileBundledAdapter(greenhouseCanary);
  const root = adapter.resolveRoot(input.form.ownerDocument);
  if (root === null) {
    return Object.freeze({
      filledBeforeUndo: 0,
      failed: 1,
      reason: 'CAPABILITY_DISABLED',
      undoRestored: false,
      currentFilledAfterUndo: 0,
    });
  }
  const fields = [...adapter.scan(root)];
  const plan = buildApplyPlan(
    { vendor: 'greenhouse', root, fields },
    { location: input.desired },
    { fillEmptyOnly: false },
  );
  const entry = plan.entries.find(
    (candidate) => candidate.kind === 'combobox' && candidate.element === input.trigger,
  );
  if (entry?.kind !== 'combobox' || entry.semanticAuthority === undefined) {
    return Object.freeze({
      filledBeforeUndo: 0,
      failed: 1,
      reason: 'CAPABILITY_DISABLED',
      undoRestored: false,
      currentFilledAfterUndo: 0,
    });
  }

  const fillMinted = mintAuthority({
    event: input.event,
    shadowRoot: input.shadowRoot,
    purpose: 'fill',
    fingerprint: plan.fingerprint,
    capabilities: new Set(['set-combobox']),
  });
  const undoMinted = mintAuthority({
    event: input.event,
    shadowRoot: input.shadowRoot,
    purpose: 'undo',
    fingerprint: null,
    capabilities: new Set(['set-combobox']),
  });
  if (!fillMinted.ok || !undoMinted.ok) {
    return Object.freeze({
      filledBeforeUndo: 0,
      failed: 1,
      reason: fillMinted.ok ? undoMinted.code : fillMinted.code,
      undoRestored: false,
      currentFilledAfterUndo: 0,
    });
  }

  const journal = createUndoJournal();
  const summary = await runApplyPlan({
    plan,
    auth: fillMinted.value,
    journal,
    root,
    policy: createBundledApplyPolicy(Date.now()),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 20,
  });
  const semanticMatchedBeforeUndo =
    entry.semanticAuthority.readSelection(input.trigger, input.desired) === 'MATCH';
  const undo = journal.canUndo()
    ? journal.undoAll(undoMinted.value)
    : null;
  const currentFilledAfterUndo =
    entry.semanticAuthority.readSelection(input.trigger, input.desired) === 'MATCH' ? 1 : 0;
  const first = summary.results[0];

  return Object.freeze({
    filledBeforeUndo: summary.filled,
    failed: summary.failed,
    reason: first?.ok === false ? first.reason : null,
    semanticMatchedBeforeUndo,
    undoRestored: undo?.restored === 1 && undo.failed === 0 && undo.remaining === 0,
    currentFilledAfterUndo,
    journalRemaining: journal.size(),
  });
}
