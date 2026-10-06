// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';

import {
  FIELD_LAB_ADAPTER_UNAVAILABLE,
  mountFieldLabShell,
  type FieldLabStageSnapshot,
} from '../field-lab/shell';

const completed: readonly FieldLabStageSnapshot[] = [
  {
    id: 'discovery',
    state: 'HELD_DEFAULT_OFF',
    detail: 'Certified UA-1 semantic epochs only; no Field Lab page fixture',
  },
  {
    id: 'compiler',
    state: 'HELD_DEFAULT_OFF',
    detail: '#164 compiler remains inside the production UA-4 runtime',
  },
  {
    id: 'classification',
    state: 'HELD_DEFAULT_OFF',
    detail: 'Question classification remains inside the production UA-4 runtime',
  },
  {
    id: 'writer',
    state: 'CALLED_FAIL_CLOSED',
    detail: 'PILOT_CAPABILITY_DISABLED · zero host calls',
  },
  {
    id: 'terminal',
    state: 'NOT_MATERIALIZED',
    detail: 'Default-off returned before any terminal ledger',
  },
];

describe('Field Lab shell', () => {
  it('renders a dev-only safety shell with one non-submit trigger and no Undo control', () => {
    const root = document.createElement('main');
    const sibling = document.createElement('aside');
    sibling.textContent = 'outside-field-lab-sentinel';
    document.body.append(root, sibling);
    mountFieldLabShell(root, async () => completed);

    expect(root.textContent).toContain('EdAIX Field Lab');
    expect(root.textContent).toContain('Unpacked development only');
    expect(root.textContent).toContain('DEFAULT_OFF');
    expect(root.textContent).toContain('NOT_RELEASED');
    expect(root.textContent).toContain('ZERO_SUBMIT');
    expect(root.textContent).toContain('Submit remains human-only');
    expect(root.querySelectorAll('button')).toHaveLength(1);
    expect(root.querySelector('button')?.textContent).toBe('Probe production UA-4 boundary');
    expect(root.querySelector('button')?.getAttribute('type')).toBe('button');
    expect(root.querySelector('[data-stage-id="writer"]')?.textContent).toContain(
      'READY_TO_PROBE',
    );
    expect(sibling.textContent).toBe('outside-field-lab-sentinel');
    expect(document.body.contains(sibling)).toBe(true);
    document.body.replaceChildren();
  });

  it('runs the production boundary only after one explicit local click', async () => {
    const root = document.createElement('main');
    const runProbes = vi.fn(async () => completed);
    mountFieldLabShell(root, runProbes);

    expect(runProbes).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(runProbes).toHaveBeenCalledTimes(1));

    expect(root.querySelector('[data-stage-id="writer"]')?.textContent).toContain(
      'CALLED_FAIL_CLOSED',
    );
    expect(root.querySelector('[data-stage-id="terminal"]')?.textContent).toContain(
      'Default-off returned before any terminal ledger',
    );
    expect(root.querySelector('[role="status"]')?.textContent).toBe(
      'Production UA-4 boundary held DEFAULT_OFF with zero host calls.',
    );
  });

  it('maps arbitrary adapter exceptions to one stable value-free UI code', async () => {
    const root = document.createElement('main');
    mountFieldLabShell(root, async () => {
      throw new Error('must never cross the view boundary');
    });

    root.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => {
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        FIELD_LAB_ADAPTER_UNAVAILABLE,
      );
    });
    expect(root.textContent).not.toContain('must never cross the view boundary');
  });
});
