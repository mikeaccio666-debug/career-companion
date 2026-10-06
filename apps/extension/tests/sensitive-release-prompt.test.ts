// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { showPendingSensitiveReleasePrompt } from '../lib/sensitiveReleasePrompt';
import {
  showPendingSensitiveReleasePromptDraft,
  type PendingSensitiveReleasePromptItem,
} from '../lib/sensitiveReleasePromptDraft';

const LEGAL_ID = '00000000-0000-4000-8000-000000000001';
const PASSWORD_ID = '00000000-0000-4000-8000-000000000002';
const STATEMENT = 'I authorize the company to obtain a background check.';
const LEGAL_ITEM = {
  kind: 'LEGAL_AUTHORIZATION',
  proposalClass: 'BACKGROUND_CHECK_AUTHORIZATION',
  promptItemId: LEGAL_ID,
  statementText: STATEMENT,
} as const satisfies PendingSensitiveReleasePromptItem;
const PASSWORD_ITEM = {
  kind: 'PASSWORD',
  proposalClass: 'PASSWORD',
  promptItemId: PASSWORD_ID,
  canonicalOrigin: 'https://jobs.example.invalid',
} as const satisfies PendingSensitiveReleasePromptItem;
const ITEMS: readonly PendingSensitiveReleasePromptItem[] = [LEGAL_ITEM, PASSWORD_ITEM];

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function radios(root: ShadowRoot): HTMLInputElement[] {
  return [...root.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
}

function submit(root: ShadowRoot): HTMLButtonElement {
  return root.querySelector('button[data-action="submit"]') as HTMLButtonElement;
}

function trustedEvent(type: string): Event {
  const event = type === 'click'
    ? new MouseEvent(type, { bubbles: true, composed: true, cancelable: true })
    : new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

function choose(root: ShadowRoot, itemId: string, decision: string): void {
  const input = radios(root).find(
    (candidate) => candidate.name.endsWith(itemId) && candidate.value === decision,
  )!;
  for (const sibling of radios(root).filter((candidate) => candidate.name === input.name)) {
    sibling.checked = sibling === input;
  }
  input.dispatchEvent(trustedEvent('change'));
}

describe('pending sensitive release prompt draft', () => {
  it('starts blank and returns only immutable local UI decisions after trusted choices', async () => {
    const prompt = showPendingSensitiveReleasePromptDraft(ITEMS);
    expect(radios(prompt.root!).every((radio) => !radio.checked)).toBe(true);
    expect(submit(prompt.root!).disabled).toBe(true);

    choose(prompt.root!, LEGAL_ID, 'RELEASE');
    expect(submit(prompt.root!).disabled).toBe(true);
    choose(prompt.root!, PASSWORD_ID, 'HANDLE_MANUALLY');
    expect(submit(prompt.root!).disabled).toBe(false);
    submit(prompt.root!).dispatchEvent(trustedEvent('click'));

    const result = await prompt.decision;
    expect(result).toEqual({
      kind: 'DECIDED',
      items: [
        {
          promptItemId: LEGAL_ID,
          decision: 'RELEASE',
        },
        {
          promptItemId: PASSWORD_ID,
          decision: 'HANDLE_MANUALLY',
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /confirmation|digest|credential|passwordValue|statementText/u,
    );
    if (result.kind === 'DECIDED') {
      expect(Object.isFrozen(result.items)).toBe(true);
      expect(result.items.every(Object.isFrozen)).toBe(true);
    }
  });

  it('rejects synthetic selection and submit events', async () => {
    const prompt = showPendingSensitiveReleasePromptDraft(ITEMS);
    const first = radios(prompt.root!)[0]!;
    first.checked = true;
    first.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    expect(submit(prompt.root!).disabled).toBe(true);

    choose(prompt.root!, LEGAL_ID, 'RELEASE');
    choose(prompt.root!, PASSWORD_ID, 'HANDLE_MANUALLY');
    submit(prompt.root!).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(document.getElementById('edaix-sensitive-release-prompt')).not.toBeNull();
    submit(prompt.root!).dispatchEvent(trustedEvent('click'));
    await expect(prompt.decision).resolves.toMatchObject({ kind: 'DECIDED' });
  });

  it('snapshots hostile caller input before rendering and decision', async () => {
    const mutable = ITEMS.map((item) => ({ ...item })) as PendingSensitiveReleasePromptItem[];
    const mutableLegal = mutable[0] as Extract<
      PendingSensitiveReleasePromptItem,
      { kind: 'LEGAL_AUTHORIZATION' }
    >;
    const prompt = showPendingSensitiveReleasePromptDraft(mutable);
    (mutableLegal as { statementText: string }).statementText = 'MUTATED';
    (mutableLegal as { promptItemId: string }).promptItemId = PASSWORD_ID;
    mutable.reverse();
    expect(prompt.root!.textContent).toContain(STATEMENT);
    expect(prompt.root!.textContent).not.toContain('MUTATED');
    choose(prompt.root!, LEGAL_ID, 'RELEASE');
    choose(prompt.root!, PASSWORD_ID, 'HANDLE_MANUALLY');
    submit(prompt.root!).dispatchEvent(trustedEvent('click'));
    await expect(prompt.decision).resolves.toMatchObject({
      kind: 'DECIDED',
      items: [
        { promptItemId: LEGAL_ID },
        { promptItemId: PASSWORD_ID },
      ],
    });
  });

  it('never accepts backend authority, credential references or password material', async () => {
    const prompt = showPendingSensitiveReleasePromptDraft(ITEMS);
    expect(prompt.root!.textContent).toContain('Password stored locally for https://jobs.example.invalid');
    expect(prompt.root!.querySelector('input[type="password"]')).toBeNull();
    prompt.dismiss();
    await prompt.decision;

    for (const invalid of [
      [{ ...LEGAL_ITEM, promptItemId: 'not-a-uuid' }],
      [{ ...LEGAL_ITEM, statementText: ' padded ' }],
      [{ ...LEGAL_ITEM, statementText: 'x'.repeat(4097) }],
      [{ ...LEGAL_ITEM, statementText: 'unsafe\u0000text' }],
      [{ ...LEGAL_ITEM, statementDigest: `hmac-sha256:v1:key:${'a'.repeat(64)}` }],
      [{ ...PASSWORD_ITEM, canonicalOrigin: 'https://jobs.example.invalid/path' }],
      [{ ...PASSWORD_ITEM, localCredentialRef: 'credential-1' }],
      [{ ...PASSWORD_ITEM, targetDigest: `hmac-sha256:v1:key:${'b'.repeat(64)}` }],
      [{ ...PASSWORD_ITEM, passwordValue: 'must-not-enter-the-prompt' }],
      [LEGAL_ITEM, { ...LEGAL_ITEM }],
    ]) {
      const rejected = showPendingSensitiveReleasePromptDraft(invalid as never);
      expect(rejected.root).toBeNull();
      await expect(rejected.decision).resolves.toEqual({
        kind: 'CANCELLED',
        reason: 'INVALID_ITEMS',
      });
    }
  });

  it.each(['pagehide', 'dismiss', 'host-removal'] as const)(
    'fails closed on %s without returning a partial decision',
    async (ending) => {
      const prompt = showPendingSensitiveReleasePromptDraft(ITEMS);
      choose(prompt.root!, LEGAL_ID, 'RELEASE');
      if (ending === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      if (ending === 'dismiss') prompt.dismiss();
      if (ending === 'host-removal') {
        document.getElementById('edaix-sensitive-release-prompt')!.remove();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await expect(prompt.decision).resolves.toMatchObject({ kind: 'CANCELLED' });
    },
  );

  it('never writes legal text or password metadata to console', async () => {
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
    );
    const prompt = showPendingSensitiveReleasePromptDraft(ITEMS);
    prompt.dismiss();
    await prompt.decision;
    const output = spies.flatMap((spy) => spy.mock.calls.flat()).join(' ');
    expect(output).not.toContain(STATEMENT);
  });
});

describe('pending sensitive production gate', () => {
  it('stays structurally disabled even if a caller fabricates every future-looking switch', async () => {
    const prompt = showPendingSensitiveReleasePrompt({
      items: ITEMS,
      runtimeAuthority: {
        allowedActions: ['DISCOVER_SENSITIVE', 'FILL_SENSITIVE'],
        policy: { capabilities: { 'set-attestation': true } },
      } as never,
      operatorGates: { releaseEnabled: true, statementTransitEnabled: true },
    });
    expect(prompt.root).toBeNull();
    await expect(prompt.decision).resolves.toEqual({
      kind: 'CANCELLED',
      reason: 'POLICY_DISABLED',
    });
  });

  it('allows no production module to bypass the gated facade by importing the draft renderer', () => {
    const roots = [
      resolve(process.cwd(), 'entrypoints'),
      resolve(process.cwd(), 'lib'),
    ];
    const violations: string[] = [];
    const visit = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory()) visit(child);
        else if (/\.(?:ts|svelte)$/u.test(entry.name) && entry.name !== 'sensitiveReleasePrompt.ts' && entry.name !== 'sensitiveReleasePromptDraft.ts') {
          if (readFileSync(child, 'utf8').includes('sensitiveReleasePromptDraft')) violations.push(child);
        }
      }
    };
    roots.forEach(visit);
    expect(violations).toEqual([]);
  });
});
