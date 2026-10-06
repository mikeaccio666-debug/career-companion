import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeAuthority, releaseAuthority, type HostWriteAuthority } from '../src/grant.ts';
import type { ApplyErrorCode } from '../src/contracts.ts';
import { createBundledApplyPolicy } from '../src/policy.ts';
import { createScanRoot } from '../src/scanRoot.ts';
import { prepareResumeFileFillOnly, type ResumeFileFillOnlyInput } from '../src/write/fileFillOnly.ts';
import { testAuthority } from './helpers/applyTestAuthority.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function putFile(target: HTMLInputElement, file: File): void {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  target.files = transfer.files;
}

function replacementFile(file: File): File {
  return new File(['%PDF-different'], file.name, { type: file.type, lastModified: file.lastModified });
}

describe('file fill-only authority and identity', () => {
  it.each([undefined, 'not-a-stable-code'])('rejects a malformed execution fence result', async (code) => {
    const { target, input } = fixture();
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    expect(await execute(input, { executionFence: () => code as ApplyErrorCode }))
      .toEqual({ ok: false, code: 'ABORTED' });
    expect(setter).not.toHaveBeenCalled();
    expect(target.files).toHaveLength(0);
  });

  it('does not treat a truthy non-boolean file policy as enabled', async () => {
    const { target, input } = fixture();
    expect(await execute(input, {
      policy: { ...input.policy, capabilities: { ...input.policy.capabilities, 'set-file': 'true' as unknown as boolean } },
    })).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(target.files).toHaveLength(0);
  });

  it('keeps a malformed native FileList read as a refusal rather than an exception', async () => {
    const { target, input } = fixture();
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')!;
    const setter = vi.fn();
    Object.defineProperty(HTMLInputElement.prototype, 'files', {
      ...original, get: () => undefined, set: setter,
    });
    try {
      const transaction = prepareResumeFileFillOnly(input)!;
      expect(transaction.isEmpty()).toBe(false);
      expect(transaction.isAtAnswer()).toBe(false);
      expect(await execute(input)).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
      expect(setter).not.toHaveBeenCalled();
      expect(target.isConnected).toBe(true);
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, 'files', original);
    }
  });

  it.each(['released-authority', 'trusted-edit'] as const)(
    'rechecks %s after the final forward execution callback', async (scenario) => {
      const { target, input } = fixture();
      const NativeTransfer = DataTransfer;
      let materialized = false;
      let finalChecks = 0;
      let epoch = 0;
      vi.stubGlobal('DataTransfer', class extends NativeTransfer {
        constructor() { super(); materialized = true; }
      });
      const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
      const result = await execute({ ...input, getTrustedUserEditEpoch: () => epoch }, {
        executionFence: () => {
          if (materialized && ++finalChecks === 2) {
            if (scenario === 'released-authority') releaseAuthority(input.authority);
            else epoch++;
          }
          return null;
        },
      });
      expect(materialized).toBe(true);
      expect(finalChecks).toBeGreaterThanOrEqual(2);
      expect(result.ok).toBe(false);
      expect(setter).not.toHaveBeenCalled();
      expect(target.files).toHaveLength(0);
    },
  );

  it.each(['disabled-policy', 'disabled-file', 'released', 'forged', 'undo'] as const)(
    'rejects %s before fresh source authorization or a setter', async (scenario) => {
      const { target, input } = fixture();
      if (scenario === 'released') releaseAuthority(input.authority);
      let authority = input.authority;
      if (scenario === 'forged') authority = { ...authority } as HostWriteAuthority;
      if (scenario === 'undo') {
        const active = consumeAuthority(testAuthority(null, 'undo', ['set-file']));
        if (!active.ok) throw new Error('TEST_AUTHORITY_UNAVAILABLE');
        authority = active.value;
      }
      const authorizeWrite = vi.fn(async () => true);
      const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
      const result = await execute(input, {
        authority, authorizeWrite,
        policy: scenario === 'disabled-policy' ? { ...input.policy, enabled: false }
          : scenario === 'disabled-file' ? {
            ...input.policy, capabilities: { ...input.policy.capabilities, 'set-file': false },
          } : input.policy,
      });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('writeEffect');
      expect(authorizeWrite).not.toHaveBeenCalled();
      expect(setter).not.toHaveBeenCalled();
      expect(target.files).toHaveLength(0);
    },
  );

  it.each(['false', 'truthy', 'throw'] as const)('requires exact fresh true, including %s', async (scenario) => {
    const { target, input } = fixture();
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const result = await execute(input, {
      authorizeWrite: async () => {
        if (scenario === 'throw') throw new Error('SYNTHETIC_SOURCE_FAILURE');
        return (scenario === 'truthy' ? 1 : false) as boolean;
      },
    });
    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(setter).not.toHaveBeenCalled();
    expect(target.files).toHaveLength(0);
  });

  it.each(['same', 'different'] as const)('preserves preexisting %s File without acquiring source authority', async (kind) => {
    const { target, file, input } = fixture();
    const existing = kind === 'same' ? file : replacementFile(file);
    putFile(target, existing);
    const transaction = prepareResumeFileFillOnly(input)!;
    expect(transaction.isEmpty()).toBe(false);
    expect(transaction.isAtAnswer()).toBe(kind === 'same');
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const authorizeWrite = vi.fn(async () => true);
    const result = await execute(input, { authorizeWrite });
    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(authorizeWrite).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
    expect(target.files?.[0]).toBe(existing);
  });

  it('preserves a file selected while fresh source approval was pending', async () => {
    const { target, file, input } = fixture();
    const userFile = replacementFile(file);
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const result = await execute(input, { authorizeWrite: async () => { putFile(target, userFile); return true; } });
    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(target.files?.[0]).toBe(userFile);
    expect(setter).toHaveBeenCalledTimes(1); // The user selection only.
  });

  it.each(['epoch', 'replace', 'detach', 'label', 'accept', 'source-metadata'] as const)(
    'revalidates %s after source authorization before any write', async (scenario) => {
      const { target, input, file } = fixture();
      let epoch = 0;
      const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
      const result = await execute({ ...input, getTrustedUserEditEpoch: () => epoch }, {
        authorizeWrite: async () => {
          if (scenario === 'epoch') epoch++;
          if (scenario === 'replace') target.replaceWith(target.cloneNode(true));
          if (scenario === 'detach') target.remove();
          if (scenario === 'label') target.labels![0]!.textContent = 'Cover letter';
          if (scenario === 'accept') target.accept = '.docx';
          if (scenario === 'source-metadata') Object.defineProperty(file, 'name', { value: 'other.pdf' });
          return true;
        },
      });
      expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
      expect(setter).not.toHaveBeenCalled();
      expect(target.files).toHaveLength(0);
    },
  );

  it('stops after a target-proof callback aborts even when that callback returns true', async () => {
    const { target, input } = fixture();
    const controller = new AbortController();
    let authorized = false;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const result = await execute({ ...input, exactTargetCurrent: () => {
      if (authorized) controller.abort();
      return true;
    } }, { signal: controller.signal, authorizeWrite: async () => { authorized = true; return true; } });
    expect(result).toEqual({ ok: false, code: 'ABORTED' });
    expect(setter).not.toHaveBeenCalled();
    expect(target.files).toHaveLength(0);
  });

  it('cannot attach after a timed-out authorization resolves later', async () => {
    const { target, input } = fixture();
    let approve: ((value: boolean) => void) | undefined;
    const authorization = new Promise<boolean>((resolve) => { approve = resolve; });
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    expect(await execute(input, { authorizeWrite: () => authorization, operationTimeoutMs: 5 }))
      .toEqual({ ok: false, code: 'VERIFY_TIMEOUT' });
    approve!(true);
    await authorization;
    await Promise.resolve();
    expect(setter).not.toHaveBeenCalled();
    expect(target.files).toHaveLength(0);
  });

  it.each([0, -1, Number.NaN, 10 * 1024 * 1024 + 1])('rejects an invalid resource ceiling %s', (maximumFileBytes) => {
    const { target, input } = fixture();
    expect(prepareResumeFileFillOnly({ ...input, maximumFileBytes })).toBeNull();
    expect(target.files).toHaveLength(0);
  });

  it.each(['generic', 'cover-letter', 'multiple', 'disabled', 'accept', 'oversized', 'epoch'] as const)(
    'does not prepare an unsafe %s attachment', (scenario) => {
      const { target, input } = fixture();
      if (scenario === 'generic') { target.id = 'attachment'; target.name = ''; document.querySelector('label')!.remove(); }
      if (scenario === 'cover-letter') target.labels![0]!.textContent = 'Cover letter';
      if (scenario === 'multiple') target.multiple = true;
      if (scenario === 'disabled') target.disabled = true;
      if (scenario === 'accept') target.accept = '.docx';
      expect(prepareResumeFileFillOnly({ ...input,
        maximumFileBytes: scenario === 'oversized' ? 1 : input.maximumFileBytes,
        getTrustedUserEditEpoch: scenario === 'epoch' ? () => Number.NaN : input.getTrustedUserEditEpoch,
      })).toBeNull();
      expect(target.files).toHaveLength(0);
    },
  );
});

describe('file fill-only host effects and final observation', () => {
  it('emits one change and no input/click/submit, and never exposes Undo', async () => {
    const { target, input } = fixture();
    const events: string[] = [];
    for (const type of ['change', 'input', 'click', 'submit']) target.form!.addEventListener(type, () => events.push(type));
    const transaction = prepareResumeFileFillOnly(input)!;
    const args = { ...input, authorizeWrite: async () => true, executionFence: () => null, lateRecheckMs: 1 };
    const result = await transaction.fillOnly(args);
    expect(result.ok).toBe(true);
    expect(events).toEqual(['change']);
    expect(result).not.toHaveProperty('undo');
    expect(result).not.toHaveProperty('recovery');
    expect(await transaction.fillOnly(args)).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    if (result.ok) result.observation.dispose();
    expect(target.files?.[0]).toBe(input.file);
  });

  it('emits no change after a setter synchronously observes Submit', async () => {
    const { target, file, input } = fixture();
    let stopped = false;
    target.form!.addEventListener('submit', (event) => { event.preventDefault(); stopped = true; });
    const change = vi.fn();
    target.addEventListener('change', change);
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')!.set!;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set').mockImplementation(function (this: HTMLInputElement, files) {
      nativeSet.call(this, files);
      target.form!.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    const result = await execute(input, { executionFence: () => stopped ? 'ABORTED' : null });
    expect(result).toMatchObject({ ok: false, writeEffect: 'MAY_HAVE_CHANGED' });
    expect(setter).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalled();
    expect(target.files?.[0]).toBe(file);
  });

  it('keeps a same-name user reupload from the change handler', async () => {
    const { target, file, input } = fixture();
    const userFile = replacementFile(file);
    target.addEventListener('change', () => putFile(target, userFile), { once: true });
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const result = await execute(input);
    expect(result).toMatchObject({ ok: false, writeEffect: 'MAY_HAVE_CHANGED' });
    expect(target.files?.[0]).toBe(userFile);
    expect(setter).toHaveBeenCalledTimes(2); // One agent attach, one user reupload.
  });

  it.each(['unknown', 'throw'] as const)('does not infer host upload acceptance from local files: %s', async (kind) => {
    const { target, file, input } = fixture();
    const result = await execute(input, { readHostValidation: () => {
      if (kind === 'throw') throw new Error('SYNTHETIC_HOST_UNAVAILABLE');
      return {};
    } });
    expect(result).toEqual({ ok: false, code: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED' });
    expect(target.files?.[0]).toBe(file);
  });

  it.each(['file', 'epoch', 'target', 'abort', 'host', 'throw'] as const)(
    'downgrades final success after consumer retirement changes %s without restoring', async (scenario) => {
      const { target, file, input } = fixture();
      const controller = new AbortController();
      let epoch = 0;
      let valid = true;
      const userFile = replacementFile(file);
      const result = await execute({ ...input, getTrustedUserEditEpoch: () => epoch }, {
        signal: controller.signal, readHostValidation: () => ({ willValidate: true, valid }),
      });
      if (!result.ok) throw new Error('EXPECTED_SUCCESS');
      const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
      const failure = result.observation.finalize(() => {
        if (scenario === 'file') putFile(target, userFile);
        if (scenario === 'epoch') epoch++;
        if (scenario === 'target') target.remove();
        if (scenario === 'abort') controller.abort();
        if (scenario === 'host') valid = false;
        if (scenario === 'throw') throw new Error('SYNTHETIC_RETIREMENT_FAILURE');
        return true;
      });
      const expected: ApplyErrorCode = scenario === 'file' ? 'LATE_REVERTED'
        : scenario === 'epoch' || scenario === 'target' ? 'IDENTITY_CHANGED'
          : scenario === 'abort' ? 'ABORTED' : 'HOST_REJECTED';
      expect(failure).toBe(expected);
      expect(target.files?.[0]).toBe(scenario === 'file' ? userFile : file);
      expect(setter).toHaveBeenCalledTimes(scenario === 'file' ? 1 : 0);
      result.observation.dispose();
    },
  );
});

function fixture() {
  document.body.innerHTML = '<form><label for="resume">Resume / CV</label><input id="resume" name="resume" type="file" accept=".pdf"></form>';
  const target = document.querySelector('input')!;
  const form = target.form!;
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    width: 240, height: 40, top: 100, left: 10, right: 250, bottom: 140,
    x: 10, y: 100, toJSON: () => ({}),
  });
  const file = new File(['%PDF-synthetic'], 'synthetic-resume.pdf', { type: 'application/pdf' });
  const active = consumeAuthority(testAuthority(null, 'fill', ['set-file']));
  if (!active.ok) throw new Error('TEST_AUTHORITY_UNAVAILABLE');
  const input = {
    target, exactTargetCurrent: () => true, file,
    root: createScanRoot(form, []), authority: active.value,
    maximumFileBytes: 1024, getTrustedUserEditEpoch: () => 0,
    policy: createBundledApplyPolicy(Date.now()),
    readHostValidation: () => ({ willValidate: true, valid: true }),
    settle: async () => undefined,
  };
  return { target, file, input };
}

function execute(
  input: ReturnType<typeof fixture>['input'],
  patch: Partial<ResumeFileFillOnlyInput> = {},
) {
  const transaction = prepareResumeFileFillOnly(input);
  if (transaction === null) throw new Error('TEST_TRANSACTION_UNAVAILABLE');
  return transaction.fillOnly({
    ...input,
    authorizeWrite: async () => true,
    executionFence: () => null,
    lateRecheckMs: 1,
    operationTimeoutMs: 100,
    ...patch,
  });
}

describe('file fill-only preservation', () => {
  it('has a successful attach control before checking failure behavior', async () => {
    const { target, file, input } = fixture();
    const result = await execute(input);
    expect(result.ok).toBe(true);
    expect(target.files?.[0]).toBe(file);
    expect(result).not.toHaveProperty('undo');
    if (result.ok) expect(result.observation.finalize()).toBeNull();
  });

  it('preserves the attempted file when the host immediately rejects it', async () => {
    const { target, file, input } = fixture();
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const result = await execute(input, {
      readHostValidation: () => ({ willValidate: true, valid: false }),
    });
    expect(result.ok).toBe(false);
    expect(target.files?.[0]).toBe(file);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ writeEffect: 'MAY_HAVE_CHANGED' });
    expect(result).not.toHaveProperty('recovery');
  });

  it('preserves the attempted file after a late host rejection', async () => {
    const { target, file, input } = fixture();
    let rejected = false;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const result = await execute(input, {
      readHostValidation: () => ({ willValidate: true, valid: !rejected }),
      lateRecheckDelay: async () => { rejected = true; },
    });
    expect(result.ok).toBe(false);
    expect(target.files?.[0]).toBe(file);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ writeEffect: 'MAY_HAVE_CHANGED' });
  });

  it('reports a setter that changed files and then threw without a second cleanup write', async () => {
    const { target, file, input } = fixture();
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')!.set!;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set').mockImplementation(function (this: HTMLInputElement, files) {
      nativeSet.call(this, files);
      throw new Error('SYNTHETIC_SETTER_FAILURE');
    });
    const result = await execute(input);
    expect(result.ok).toBe(false);
    expect(target.files?.[0]).toBe(file);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ writeEffect: 'MAY_HAVE_CHANGED' });
  });
});


describe('independent final callback boundary', () => {
  it('does not emit change for a trusted reupload during the final execution callback', async () => {
    const { target, file, input } = fixture();
    const replacement = replacementFile(file);
    const NativeEvent = Event;
    let eventConstructed = false;
    let checks = 0;
    let epoch = 0;
    vi.stubGlobal('Event', class extends NativeEvent {
      constructor(type: string, init?: EventInit) {
        super(type, init);
        if (type === 'change') eventConstructed = true;
      }
    });
    const change = vi.fn();
    target.addEventListener('change', change);
    const result = await execute({ ...input, getTrustedUserEditEpoch: () => epoch }, {
      executionFence: () => {
        if (eventConstructed && ++checks === 2) {
          putFile(target, replacement);
          epoch += 1;
        }
        return null;
      },
    });
    expect(eventConstructed).toBe(true);
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(target.files?.[0]).toBe(replacement);
    expect(result).toMatchObject({ ok: false, writeEffect: 'MAY_HAVE_CHANGED' });
    expect(change).not.toHaveBeenCalled();
  });

  it('does not attach after a final execution callback changes the target to Cover letter', async () => {
    const { target, input } = fixture();
    const NativeTransfer = DataTransfer;
    let materialized = false;
    let checks = 0;
    vi.stubGlobal('DataTransfer', class extends NativeTransfer {
      constructor() { super(); materialized = true; }
    });
    const setter = vi.spyOn(HTMLInputElement.prototype, 'files', 'set');
    const result = await execute(input, {
      executionFence: () => {
        if (materialized && ++checks === 2) target.labels![0]!.textContent = 'Cover letter';
        return null;
      },
    });
    expect(materialized).toBe(true);
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
    expect(setter).not.toHaveBeenCalled();
    expect(target.files).toHaveLength(0);
  });
});
