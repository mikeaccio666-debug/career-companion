import { describe, expect, it } from 'vitest';
import { parseExecutionRuntimeWizardDeclarationV1 } from '../src/index';

const declaration = {
  schemaVersion: 1, wizardKey: 'test-wizard', applicationRootSelector: '#application',
  indicatorContainerSelector: '#steps', steps: [{ stepKey: 'one', indicatorSelector: '#one' }],
};

describe('execution runtime wizard declaration wire', () => {
  it('exports one immutable data-only parser, with no navigation or execution field', () => {
    const result = parseExecutionRuntimeWizardDeclarationV1(declaration);
    expect(result).toEqual({ ok: true, value: declaration });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.steps[0])).toBe(true);
    }
    expect(parseExecutionRuntimeWizardDeclarationV1({ ...declaration, grant: true }).ok).toBe(false);
  });
  it('rejects hostile accessors without invoking them', () => {
    let reads = 0;
    const hostile = { ...declaration };
    Object.defineProperty(hostile, 'wizardKey', { enumerable: true, get() { reads++; return 'test-wizard'; } });
    expect(parseExecutionRuntimeWizardDeclarationV1(hostile).ok).toBe(false);
    expect(reads).toBe(0);
  });
});
