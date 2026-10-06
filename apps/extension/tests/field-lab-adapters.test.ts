import { describe, expect, it } from 'vitest';

import { probeExecutionPort } from '../field-lab/adapters/executionAdapter';

describe('Field Lab production UA-4 adapter', () => {
  it('calls the production composition runtime under its hard disabled policy', async () => {
    await expect(probeExecutionPort()).resolves.toEqual({
      port: 'UA-4_WRITER_RUNTIME',
      state: 'CALLED_FAIL_CLOSED',
      code: 'PILOT_CAPABILITY_DISABLED',
      liveTargetTouched: false,
    });
  });
});
