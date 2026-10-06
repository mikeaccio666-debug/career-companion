import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyPlan, ApplyWriteResult } from '../src/contracts';
import {
  checkActiveCapability,
  consumeAuthority,
  mintAuthority,
  narrowAuthority,
  type HostWriteAuthority,
} from '../src/grant';
import { runApplyPlan } from '../src/runner';
import { fieldSignature } from '../src/fieldIdentity';
import { testApplyPolicy } from './helpers/applyTestAuthority';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal, type UndoJournal } from '../src/undo';
import { writeTextValue } from '../src/write/setValue';

/**
 * C3/C5 的最小安全护栏：没有 journal 产出的 ticket、没有来自我方 Shadow
 * 点击的 authority，runner 都必须在碰宿主控件前失败关闭。这里的 event 是
 * happy-dom 中的可信用户手势替身；生产代码仍只接受浏览器给出的 isTrusted=true。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function planFor(element: HTMLInputElement, fingerprint = 'plan-safe-1'): ApplyPlan {
  const root = createScanRoot(document.body, []);
  return {
    vendor: 'greenhouse',
    fingerprint,
    fillEmptyOnly: true,
    entries: [
      {
        kind: 'text',
        required: false,
        key: 'email',
        label: 'Email',
        value: 'alex@example.com',
        element,
        confidence: 1,
        order: 0,
        signature: fieldSignature(element, root),
      },
    ],
    skipped: [],
  };
}

function trustedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });

  // happy-dom 的 Event 没有浏览器填入的 isTrusted；只在测试替身上定义它。
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  return { event, shadowRoot };
}

function fillAuthority(fingerprint: string): HostWriteAuthority {
  const { event, shadowRoot } = trustedShadowClick();
  const minted = mintAuthority({ event, shadowRoot, purpose: 'fill', fingerprint });
  expect(minted).toMatchObject({ ok: true });
  if (!minted.ok) throw new Error(`test authority unexpectedly rejected: ${minted.code}`);
  return minted.value;
}

function unavailableJournal(): UndoJournal {
  return {
    record: () => ({ ok: false, code: 'JOURNAL_UNAVAILABLE' }),
    recordStructuralAction: () => ({ ok: false, code: 'JOURNAL_UNAVAILABLE' }),
    commit: () => undefined,
    commitSemantic: () => false,
    retainSemanticFailure: () => false,
    commitFile: () => undefined,
    abandon: () => undefined,
    canUndo: () => false,
    hasRestorable: () => true,
    size: () => 0,
    requiredUndoCapabilities: () => new Set(),
    undoAll: () => ({
      restored: 0,
      skippedUserEdited: 0,
      abandonedDetached: 0,
      failed: 0,
      remaining: 0,
    }),
    undoAllSettled: async () => ({
      restored: 0,
      skippedUserEdited: 0,
      abandonedDetached: 0,
      failed: 0,
      remaining: 0,
    }),
    clear: () => undefined,
  };
}

describe('apply write authority', () => {
  it('no authority means zero host writes', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const plan = planFor(input);

    const run = await runApplyPlan({
      plan,
      auth: undefined as unknown as HostWriteAuthority,
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(input.value).toBe('');
    expect(run.results).toEqual<ApplyWriteResult[]>([
      { key: 'email', label: 'Email', ok: false, reason: 'GESTURE_UNTRUSTED' },
    ]);
  });

  it('a missing WriteTicket from the journal means zero host writes', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const plan = planFor(input);

    const run = await runApplyPlan({
      plan,
      auth: fillAuthority(plan.fingerprint),
      journal: unavailableJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(input.value).toBe('');
    expect(run.results).toEqual<ApplyWriteResult[]>([
      { key: 'email', label: 'Email', ok: false, reason: 'JOURNAL_UNAVAILABLE' },
    ]);
  });

  it('an authority bound to another plan fingerprint means zero host writes', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const plan = planFor(input, 'plan-current');

    const run = await runApplyPlan({
      plan,
      auth: fillAuthority('plan-previewed-earlier'),
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(input.value).toBe('');
    expect(run.results).toEqual<ApplyWriteResult[]>([
      { key: 'email', label: 'Email', ok: false, reason: 'PLAN_STALE' },
    ]);
  });

  it('the same authority cannot write a second time', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const plan = planFor(input);
    const auth = fillAuthority(plan.fingerprint);
    const journal = createUndoJournal();

    expect(
      (
        await runApplyPlan({
          plan,
          auth,
          journal,
          root: createScanRoot(document.body, []),
          policy: testApplyPolicy(),
        })
      ).filled,
    ).toBe(1);
    input.value = '';

    const repeated = await runApplyPlan({
      plan,
      auth,
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });
    expect(input.value).toBe('');
    expect(repeated.results).toEqual<ApplyWriteResult[]>([
      { key: 'email', label: 'Email', ok: false, reason: 'GRANT_CONSUMED' },
    ]);
  });

  it('write primitives require both a consumed authority and a WriteTicket at compile time', () => {
    if (false) {
      const input = document.createElement('input');
      const authority = undefined as unknown as HostWriteAuthority;
      // @ts-expect-error WriteTicket is a required fourth argument.
      writeTextValue(input, 'x', authority);
    }
    expect(true).toBe(true);
  });

  it('an authority must come from a trusted event inside the supplied ShadowRoot', () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const synthetic = new Event('click', { bubbles: true, composed: true });

    expect(mintAuthority({ event: synthetic, shadowRoot, purpose: 'fill', fingerprint: 'x' })).toEqual({
      ok: false,
      code: 'GESTURE_UNTRUSTED',
    });
  });

  it('consumeAuthority refuses an authority a second time', () => {
    const auth = fillAuthority('plan-consume-once');
    expect(consumeAuthority(auth)).toMatchObject({ ok: true });
    expect(consumeAuthority(auth)).toEqual({ ok: false, code: 'GRANT_CONSUMED' });
  });

  it('a policy refresh can only remove capabilities from an already trusted click', () => {
    const auth = fillAuthority('plan-narrow');
    expect(narrowAuthority(auth, new Set(['set-text']))).toMatchObject({ ok: true });
    // A later, broader response cannot re-add set-select to the same grant.
    expect(narrowAuthority(auth, new Set(['set-text', 'set-select']))).toMatchObject({ ok: true });
    expect(consumeAuthority(auth)).toMatchObject({ ok: true });
    expect(checkActiveCapability(auth, 'set-text')).toMatchObject({ ok: true });
    expect(checkActiveCapability(auth, 'set-select')).toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });
  });
});
