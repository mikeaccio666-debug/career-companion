import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { createScanRoot } from '../src/scanRoot';
import {
  settleResumeFileWrite,
  type ResumeFileSettlePhase,
} from '../src/write/fileSemanticSettle';
import { createUndoJournal } from '../src/undo';
import { testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function activeAuthority(purpose: 'fill' | 'undo' = 'fill'): HostWriteAuthority {
  const authority = testAuthority(null, purpose, ['set-file']);
  const active = consumeAuthority(authority);
  expect(active.ok, '测试前置：set-file authority 未进入 active 状态').toBe(true);
  if (!active.ok) throw new Error(active.code);
  return active.value;
}

function syntheticPdf(name = 'synthetic-resume.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
}

function mountResumeTarget(extraAttributes = ''): {
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
} {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="resume-upload">Resume / CV</label>
      <input id="resume-upload" name="resume" type="file" ${extraAttributes} />
    </form>`;
  const form = document.querySelector('form') as HTMLFormElement;
  const input = document.querySelector('input') as HTMLInputElement;
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
    width: 240,
    height: 40,
    top: 100,
    left: 10,
    right: 250,
    bottom: 140,
    x: 10,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect);
  return { form, input };
}

function ticketFor(input: HTMLInputElement) {
  return createUndoJournal().record(input);
}

const acceptedByHost = () => ({ willValidate: true, valid: true }) as const;

describe('dormant file-input semantic settle leaf', () => {
  it('accept 只能补充文件兼容性，不能单独证明这是简历目标', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <input id="generic-upload" type="file" accept=".pdf" />
      </form>`;
    const form = document.querySelector('form') as HTMLFormElement;
    const input = document.querySelector('input') as HTMLInputElement;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      width: 240, height: 40, top: 100, left: 10, right: 250, bottom: 140, x: 10, y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    const readHostValidation = vi.fn(acceptedByHost);

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation,
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'FILE_TARGET_UNAPPROVED' });
    expect(input.files).toHaveLength(0);
    expect(readHostValidation).not.toHaveBeenCalled();
  });

  it('resolver 指向另一个节点时，原控件即使像简历位也禁止写入', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const wrongTarget = document.createElement('input');
    wrongTarget.type = 'file';
    wrongTarget.name = 'resume';
    const readHostValidation = vi.fn(acceptedByHost);

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => wrongTarget,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation,
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'FILE_TARGET_UNAPPROVED' });
    expect(input.files).toHaveLength(0);
    expect(readHostValidation).not.toHaveBeenCalled();
  });

  it('预先存在的同一 File 引用属于用户，NOT_EMPTY 绝不把它清掉', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const userFile = syntheticPdf('synthetic-user-owned.pdf');
    const existing = new DataTransfer();
    existing.items.add(userFile);
    input.files = existing.files;
    const inputEvents: Event[] = [];
    const changeEvents: Event[] = [];
    input.addEventListener('input', (event) => inputEvents.push(event));
    input.addEventListener('change', (event) => changeEvents.push(event));
    const readHostValidation = vi.fn(acceptedByHost);

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: userFile,
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation,
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'NOT_EMPTY' });
    expect(input.files?.[0]).toBe(userFile);
    expect(inputEvents).toHaveLength(0);
    expect(changeEvents).toHaveLength(0);
    expect(readHostValidation).not.toHaveBeenCalled();
  });

  it('pre-aborted signal 在 attach 与 host event 前 fail closed', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const controller = new AbortController();
    controller.abort();
    const inputEvents: Event[] = [];
    const changeEvents: Event[] = [];
    input.addEventListener('input', (event) => inputEvents.push(event));
    input.addEventListener('change', (event) => changeEvents.push(event));
    const readHostValidation = vi.fn(acceptedByHost);

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation,
      signal: controller.signal,
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'FILE_SETTLE_ABORTED' });
    expect(input.files).toHaveLength(0);
    expect(inputEvents).toHaveLength(0);
    expect(changeEvents).toHaveLength(0);
    expect(readHostValidation).not.toHaveBeenCalled();
  });

  it('undo-purpose authority 不能用于首次 attach', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority('undo'),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'FILE_WRITE_AUTHORITY_REQUIRED' });
    expect(input.files).toHaveLength(0);
  });

  it('即时 files.length=1 仍不能假绿：late recheck 清空时稳定失败', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const observedLengths: number[] = [];

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => document.querySelector('#resume-upload') as HTMLInputElement | null,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async (phase) => {
        observedLengths.push(input.files?.length ?? 0);
        if (phase === 'LATE_RECHECK') input.files = new DataTransfer().files;
      },
    });

    expect(observedLengths).toEqual([1, 1]);
    expect(result).toEqual({ ok: false, code: 'FILE_CLEARED_DURING_SETTLE' });
    expect(input.files).toHaveLength(0);
  });

  it('late settle 后 current accept 不再兼容时稳定失败，并只清理 exact-owned File', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const file = syntheticPdf();

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file,
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async (phase) => {
        if (phase === 'LATE_RECHECK') input.accept = '.docx';
      },
    });

    expect(result).toEqual({ ok: false, code: 'VALUE_COERCED' });
    expect(input.files).toHaveLength(0);
  });

  it('宿主延迟拒绝会在 late recheck 被识别并补偿 DOM FileList', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    let rejected = false;
    const readHostValidation = vi.fn(() =>
      rejected
        ? { ariaInvalid: 'true', willValidate: true, valid: false, validationMessage: 'synthetic' }
        : acceptedByHost(),
    );

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => document.querySelector('#resume-upload') as HTMLInputElement | null,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation,
      settle: async (phase) => {
        if (phase === 'LATE_RECHECK') rejected = true;
      },
    });

    expect(readHostValidation).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, code: 'FILE_HOST_REJECTED' });
    expect(input.files, '已知 exact owned File 应被安全清回 empty').toHaveLength(0);
  });

  it('production 250ms late scheduler 会抓住真实定时清空；测试不注入 settle', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer));
    const { form, input } = mountResumeTarget('accept=".pdf"');
    let scheduled = false;
    input.addEventListener('change', () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        input.files = new DataTransfer().files;
      }, 200);
    });
    const readHostValidation = vi.fn(acceptedByHost);

    let completed = false;
    const pending = settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation,
    }).finally(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(199);
    expect(readHostValidation).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toEqual({
      ok: false,
      code: 'FILE_CLEARED_DURING_SETTLE',
    });
    expect(input.files).toHaveLength(0);
  });

  it('production 250ms late scheduler 会抓住真实定时 host reject；测试不注入 settle', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer));
    const { form, input } = mountResumeTarget('accept=".pdf"');
    let rejected = false;
    let scheduled = false;
    input.addEventListener('change', () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        rejected = true;
      }, 200);
    });
    const readHostValidation = vi.fn(() =>
      rejected
        ? { ariaInvalid: 'true', willValidate: true, valid: false }
        : acceptedByHost(),
    );

    let completed = false;
    const pending = settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation,
    }).finally(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(199);
    expect(readHostValidation).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toEqual({ ok: false, code: 'FILE_HOST_REJECTED' });
    expect(readHostValidation).toHaveBeenCalledTimes(2);
    expect(input.files).toHaveLength(0);
  });

  it('即时 compensation 被宿主回填 original File 时保留 recovery，fresh Undo 可成功', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const file = syntheticPdf();
    let changeCount = 0;
    input.addEventListener('change', () => {
      changeCount += 1;
      if (changeCount !== 2) return;
      const restored = new DataTransfer();
      restored.items.add(file);
      input.files = restored.files;
    });

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file,
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => ({
        ariaInvalid: 'true',
        willValidate: true,
        valid: false,
      }),
      settle: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.recovery === undefined) {
      throw new Error('expected exact-owned retained recovery');
    }
    expect(result.code).toBe('FILE_HOST_REJECTED');
    expect(result.recovery.isOwnedState()).toBe(true);
    expect(input.files?.[0]).toBe(file);
    expect(result.recovery.restore(activeAuthority('undo'))).toEqual({
      ok: true,
      value: undefined,
    });
    expect(changeCount).toBe(3);
    expect(input.files).toHaveLength(0);
  });

  it('相同属性的新节点也不是原 exact target：DOM replacement 必须失败', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => document.querySelector('#resume-upload') as HTMLInputElement | null,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async (phase) => {
        if (phase !== 'LATE_RECHECK') return;
        const replacement = document.createElement('input');
        replacement.id = 'resume-upload';
        replacement.name = 'resume';
        replacement.type = 'file';
        replacement.accept = '.pdf';
        input.replaceWith(replacement);
      },
    });

    expect(result).toEqual({ ok: false, code: 'FILE_TARGET_REPLACED' });
    expect(document.querySelector<HTMLInputElement>('#resume-upload')?.files).toHaveLength(0);
    expect('recovery' in result ? result.recovery : undefined).toBeUndefined();
  });

  it('host validation callback 内替换 target 也不能返回 accepted 假绿', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    let validationReads = 0;

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => document.querySelector('#resume-upload') as HTMLInputElement | null,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => {
        validationReads += 1;
        if (validationReads === 2) {
          const replacement = document.createElement('input');
          replacement.id = 'resume-upload';
          replacement.name = 'resume';
          replacement.type = 'file';
          replacement.accept = '.pdf';
          input.replaceWith(replacement);
        }
        return acceptedByHost();
      },
      settle: async () => undefined,
    });

    expect(validationReads).toBe(2);
    expect(result).toEqual({ ok: false, code: 'FILE_TARGET_REPLACED' });
    expect('recovery' in result ? result.recovery : undefined).toBeUndefined();
  });

  it('host validation 无法证明 accepted 时 fail closed，不把 unknown 当成功', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => ({}),
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'FILE_HOST_UNVERIFIED' });
    expect(input.files).toHaveLength(0);
  });

  it('host validation reader 抛错时用稳定 unverified 原因码并安全补偿', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => {
        throw new Error('synthetic host reader failure');
      },
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'FILE_HOST_UNVERIFIED' });
    expect(input.files).toHaveLength(0);
  });

  it('host validation callback 内 abort 不能返回 accepted 假绿', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const controller = new AbortController();
    let reads = 0;

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => {
        reads += 1;
        if (reads === 2) controller.abort();
        return acceptedByHost();
      },
      signal: controller.signal,
      settle: async () => undefined,
    });

    expect(result).toEqual({ ok: false, code: 'FILE_SETTLE_ABORTED' });
    expect(reads).toBe(2);
    expect(input.files).toHaveLength(0);
  });

  it('最终 ownership proof 的 resolver 同步 abort 也不能返回 SETTLED', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const controller = new AbortController();
    let validationReads = 0;
    let resolvesBeforeAbort: number | null = null;

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => {
        if (resolvesBeforeAbort !== null) {
          if (resolvesBeforeAbort === 0) controller.abort();
          else resolvesBeforeAbort -= 1;
        }
        return input;
      },
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => {
        validationReads += 1;
        if (validationReads === 2) resolvesBeforeAbort = 1;
        return acceptedByHost();
      },
      signal: controller.signal,
      settle: async () => undefined,
    });

    expect(validationReads).toBe(2);
    expect(controller.signal.aborted).toBe(true);
    expect(result).toEqual({ ok: false, code: 'FILE_SETTLE_ABORTED' });
    expect(input.files).toHaveLength(0);
  });

  it('最终 ownership proof 内 accept 漂移后仍须在返回 SETTLED 前失败并补偿', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const file = syntheticPdf();
    let validationReads = 0;
    let resolvesBeforeDrift: number | null = null;

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => {
        if (resolvesBeforeDrift !== null) {
          if (resolvesBeforeDrift === 0) input.accept = '.docx';
          else resolvesBeforeDrift -= 1;
        }
        return input;
      },
      root: createScanRoot(form, []),
      file,
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: () => {
        validationReads += 1;
        if (validationReads === 2) resolvesBeforeDrift = 1;
        return acceptedByHost();
      },
      settle: async () => undefined,
    });

    expect(validationReads).toBe(2);
    expect(input.accept).toBe('.docx');
    expect(result).toEqual({ ok: false, code: 'VALUE_COERCED' });
    expect(input.files).toHaveLength(0);
  });

  it('settle callback 挂起也受 deadline 约束，并对 exact owned File 做安全补偿', async () => {
    vi.useFakeTimers();
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const never = new Promise<void>(() => undefined);
    const pending = settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settleTimeoutMs: 25,
      settle: () => never,
    });

    await vi.advanceTimersByTimeAsync(26);
    await expect(pending).resolves.toEqual({ ok: false, code: 'FILE_SETTLE_TIMEOUT' });
    expect(input.files).toHaveLength(0);
  });

  it('只有两阶段 accepted + exact owned state 才返回 SETTLED 与安全 Undo', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const phases: ResumeFileSettlePhase[] = [];

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async (phase) => { phases.push(phase); },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.status).toBe('SETTLED');
    expect(phases).toEqual(['INITIAL_SETTLE', 'LATE_RECHECK']);
    expect(result.undo.isOwnedState()).toBe(true);
    expect('compensate' in result.undo).toBe(false);
    expect(result.undo.restore(activeAuthority('fill'))).toEqual({
      ok: false,
      code: 'FILE_UNDO_AUTHORITY_REQUIRED',
    });
    expect(input.files?.[0]?.name).toBe('synthetic-resume.pdf');
    expect(result.undo.restore(activeAuthority('undo'))).toEqual({ ok: true, value: undefined });
    expect(input.files).toHaveLength(0);
  });

  it('成功路径不触发 submit/requestSubmit/click', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const submitEvents: Event[] = [];
    form.addEventListener('submit', (event) => submitEvents.push(event));
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    const click = vi.spyOn(HTMLElement.prototype, 'click');

    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(submitEvents).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('用户替换文件后 Undo 失去 ownership，绝不清掉用户的新文件', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file: syntheticPdf(),
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    const userFile = new File(['synthetic-user-choice'], 'user-choice.pdf', {
      type: 'application/pdf',
    });
    const replacement = new DataTransfer();
    replacement.items.add(userFile);
    input.files = replacement.files;

    expect(result.undo.isOwnedState()).toBe(false);
    expect(result.undo.restore(activeAuthority('undo'))).toEqual({
      ok: false,
      code: 'FILE_UNDO_NOT_OWNED',
    });
    expect(input.files?.[0]).toBe(userFile);
  });

  it('same metadata 的不同 File object 仍不是 owned state，Undo 不得覆盖', async () => {
    const { form, input } = mountResumeTarget('accept=".pdf"');
    const file = syntheticPdf();
    const result = await settleResumeFileWrite({
      element: input,
      resolveCurrentTarget: () => input,
      root: createScanRoot(form, []),
      file,
      authority: activeAuthority(),
      ticket: ticketFor(input),
      policy: createBundledApplyPolicy(Date.now()),
      readHostValidation: acceptedByHost,
      settle: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);

    const sameMetadataReplacement = new File(
      [new Uint8Array([0x25, 0x50, 0x44, 0x46])],
      file.name,
      { type: file.type, lastModified: file.lastModified },
    );
    expect(sameMetadataReplacement).not.toBe(file);
    expect({
      name: sameMetadataReplacement.name,
      size: sameMetadataReplacement.size,
      type: sameMetadataReplacement.type,
      lastModified: sameMetadataReplacement.lastModified,
    }).toEqual({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    });
    const replacement = new DataTransfer();
    replacement.items.add(sameMetadataReplacement);
    input.files = replacement.files;

    expect(result.undo.isOwnedState()).toBe(false);
    expect(result.undo.restore(activeAuthority('undo'))).toEqual({
      ok: false,
      code: 'FILE_UNDO_NOT_OWNED',
    });
    expect(input.files?.[0]).toBe(sameMetadataReplacement);
  });
});
