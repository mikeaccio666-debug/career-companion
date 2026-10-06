import { afterEach, describe, expect, it } from 'vitest';

import { optionSetSignature } from '../src/click/optionSearch';
import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ComboboxOptionHarvest } from '../src/contracts';

afterEach(() => {
  document.body.innerHTML = '';
});

function mountLocationCombobox() {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="location">Location</label>
      <input id="location" role="combobox" type="text" />
    </form>`;
  const root = greenhouseAdapter.resolveRoot(document)!;
  const trigger = document.querySelector<HTMLInputElement>('#location')!;
  return { root, trigger };
}

describe('combobox preview verdict enters the reviewed plan immutably', () => {
  it('rejects a forged resolution even when its signature is internally valid', () => {
    const { root, trigger } = mountLocationCombobox();
    const optionTexts = ['Job Fair', 'LinkedIn', 'Referral'];
    const built = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { location: 'Seattle' },
      {
        comboboxHarvests: new Map([[trigger, {
          candidates: ['Seattle'],
          optionTexts,
          optionSetSignature: optionSetSignature(optionTexts),
          resolvedOptionText: 'LinkedIn',
        }]]),
      },
    );

    expect(built.entries.find((entry) => entry.key === 'location')).toBeUndefined();
    expect(built.skipped.find((entry) => entry.key === 'location')?.reason).toBe(
      'NO_OPTION_MATCH',
    );
  });

  it('seals ordered candidates, signature, and resolved option into the plan', () => {
    const { root, trigger } = mountLocationCombobox();
    const optionTexts = ['Seattle', 'Portland'];
    const harvest = {
      candidates: ['Seattle'],
      optionTexts,
      optionSetSignature: optionSetSignature(optionTexts),
      resolvedOptionText: 'Seattle',
    };
    const built = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { location: 'Seattle' },
      { comboboxHarvests: new Map([[trigger, harvest]]) },
    );
    const entry = built.entries.find((candidate) => candidate.key === 'location');

    expect(entry).toMatchObject({
      kind: 'combobox',
      comboboxCandidates: ['Seattle'],
      comboboxHarvest: {
        candidates: ['Seattle'],
        optionTexts: ['Seattle', 'Portland'],
      },
      resolvedOptionText: 'Seattle',
    });
    if (entry?.kind !== 'combobox' || !entry.comboboxHarvest) {
      throw new Error('test precondition: sealed combobox harvest missing');
    }
    expect(entry.comboboxHarvest).not.toBe(harvest);
    harvest.candidates[0] = 'Hostile candidate';
    harvest.optionTexts[0] = 'Hostile option';
    harvest.resolvedOptionText = 'Hostile option';
    expect(entry.comboboxHarvest.candidates).toEqual(['Seattle']);
    expect(entry.comboboxHarvest.optionTexts).toEqual(['Seattle', 'Portland']);
    expect(entry.comboboxHarvest.resolvedOptionText).toBe('Seattle');
  });

  it('rejects candidate drift before the plan can be reviewed', () => {
    const { root, trigger } = mountLocationCombobox();
    const optionTexts = ['Seattle', 'Portland'];
    const built = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { location: 'Seattle' },
      {
        comboboxHarvests: new Map([[trigger, {
          candidates: ['Portland'],
          optionTexts,
          optionSetSignature: optionSetSignature(optionTexts),
          resolvedOptionText: 'Portland',
        }]]),
      },
    );

    expect(built.entries.find((entry) => entry.key === 'location')).toBeUndefined();
    expect(built.skipped.find((entry) => entry.key === 'location')?.reason).toBe(
      'IDENTITY_CHANGED',
    );
  });

  it('rejects an over-bound caller harvest before signature or matching work', () => {
    const { root, trigger } = mountLocationCombobox();
    const hostile = {
      candidates: ['Seattle'],
      optionTexts: Array.from({ length: 1_025 }, () => 'Seattle'),
      optionSetSignature: 'hostile',
      resolvedOptionText: 'Seattle',
    } as ComboboxOptionHarvest;

    const built = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
      { location: 'Seattle' },
      { comboboxHarvests: new Map([[trigger, hostile]]) },
    );

    expect(built.entries.find((entry) => entry.key === 'location')).toBeUndefined();
    expect(built.skipped.find((entry) => entry.key === 'location')?.reason).toBe(
      'IDENTITY_CHANGED',
    );
  });
});
