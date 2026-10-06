import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApplySession } from '../src/session.svelte';
import { fieldSignature } from '../src/fieldIdentity';
import { readApplyForm } from '../src/registry';
import { createScanRoot } from '../src/scanRoot';
import { createBundledApplyPolicy } from '../src/policy';
import type { ApplyFormDescriptor } from '../src/contracts';
import { beginMainWorldReactChange } from '../src/write/mainWorldBridge';
import { installMainWorldBridge } from '../src/write/mainWorldHandler';
import { APPLY_MAIN_WORLD_REQUEST_EVENT } from '../src/write/mainWorldProtocol';
import { WRITE_VERIFICATION_TIMEOUT_MS } from '../src/write/verify';
import { installBundledApplyAdapters } from '../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function formFor(element: HTMLInputElement, confidence = 1): ApplyFormDescriptor {
  const root = createScanRoot(document.body, []);
  return {
    vendor: 'greenhouse',
    root,
    fields: [
      {
        kind: 'text',
        key: 'email',
        label: 'Email',
        element,
        required: true,
        confidence,
        signature: fieldSignature(element, root),
      },
    ],
  };
}

function trustedShadowClick(): { event: Event; shadowRoot: ShadowRoot } {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', {
    value: () => [button, shadowRoot, host, document.body, document, window],
  });
  return { event, shadowRoot };
}

function saveProfileFromShadow(session: ReturnType<typeof createApplySession>): Promise<void> {
  const click = trustedShadowClick();
  return session.saveProfile(click.event, click.shadowRoot);
}

function testSession(
  loadPolicy: () => Promise<ReturnType<typeof createBundledApplyPolicy>> = async () => createBundledApplyPolicy(Date.now()),
  rescanForm: () => ApplyFormDescriptor | null = () => null,
) {
  return createApplySession({
    hostIsKnownAts: true,
    vendor: 'greenhouse',
    readProfile: async () => ({
      ok: true,
      value: { draft: { email: 'alex@example.com' }, readOnly: false },
    }),
    writeProfile: async () => ({ ok: true, value: undefined }),
    loadPolicy,
    rescanForm,
  });
}

describe('content-owned apply session', () => {
  it('does not read an account profile, legacy draft, or resume metadata until the candidate opens the launcher', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const readProfile = vi.fn(async () => ({
      ok: true as const,
      value: { draft: { email: 'only-after-open@example.test' }, revision: 1, suppressedKeys: [] },
    }));
    const readResumeFileName = vi.fn(async () => 'Only_after_open.pdf');
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile,
      readResumeFileName,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));

    await Promise.resolve();
    expect(readProfile).not.toHaveBeenCalled();
    expect(readResumeFileName).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({
      open: false,
      profileStatus: 'loading',
      plan: null,
    });

    session.setOpen(true);
    await session.ready();
    expect(readProfile).toHaveBeenCalledTimes(1);
    expect(readResumeFileName).toHaveBeenCalledTimes(1);
    expect(session.snapshot().plan?.entries[0]?.value).toBe('only-after-open@example.test');

    session.setOpen(false);
    session.setOpen(true);
    await Promise.resolve();
    expect(readProfile).toHaveBeenCalledTimes(1);
    expect(readResumeFileName).toHaveBeenCalledTimes(1);
  });

  it('简历 metadata 变慢时不阻塞纯文本预览，晚到后再增量加入文件栏', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="email">Email</label><input id="email" type="email" />
        <label for="resume">Resume/CV</label><input id="resume" type="file" />
      </form>`;
    let resolveFileName!: (value: string | null) => void;
    const pendingFileName = new Promise<string | null>((resolve) => {
      resolveFileName = resolve;
    });
    const session = createApplySession({
    hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'alex@example.test' }, readOnly: false },
      }),
      readResumeFileName: () => pendingFileName,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => readApplyForm('greenhouse'),
    });
    session.setForm(readApplyForm('greenhouse'));

    session.setOpen(true);

    await session.ready();
    expect(session.snapshot()).toMatchObject({ phase: 'idle', profileStatus: 'ready' });
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['email']);

    resolveFileName('Ada_Lovelace.pdf');
    await vi.waitFor(() =>
      expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual([
        'email',
        'resumeFile',
      ]),
    );
  });

  it('简历 metadata 在 Fill 中到达时冻结本轮，并在结算后重新开放文件预览', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="email">Email</label><input id="email" type="email" />
        <label for="resume">Resume/CV</label><input id="resume" type="file" />
      </form>`;
    let resolveFileName!: (value: string | null) => void;
    const pendingFileName = new Promise<string | null>((resolve) => {
      resolveFileName = resolve;
    });
    let resolvePolicy!: (value: ReturnType<typeof createBundledApplyPolicy>) => void;
    const pendingPolicy = new Promise<ReturnType<typeof createBundledApplyPolicy>>((resolve) => {
      resolvePolicy = resolve;
    });
    const session = createApplySession({
    hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'alex@example.test' }, readOnly: false },
      }),
      readResumeFileName: () => pendingFileName,
      loadPolicy: () => pendingPolicy,
      rescanForm: () => readApplyForm('greenhouse'),
    });
    session.setForm(readApplyForm('greenhouse'));
    session.setOpen(true);
    await session.ready();

    const click = trustedShadowClick();
    const filling = session.fill(click.event, click.shadowRoot);
    expect(session.snapshot()).toMatchObject({ phase: 'filling', run: null });
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['email']);

    resolveFileName('Ada_Lovelace.pdf');
    await vi.waitFor(() => expect(session.snapshot().phase).toBe('filling'));
    // Metadata cannot silently expand the plan covered by the current click.
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['email']);

    resolvePolicy(createBundledApplyPolicy(Date.now()));
    await filling;

    const state = session.snapshot();
    expect(document.querySelector<HTMLInputElement>('#email')?.value).toBe('alex@example.test');
    expect(state).toMatchObject({ phase: 'idle', run: null, undoCount: 1 });
    expect(state.plan?.entries.map((entry) => entry.key)).toEqual(['resumeFile']);
  });

  it('浮层订阅重挂后仍保留同一轮 Fill 的 Undo journal', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const session = testSession();
    const descriptor = formFor(input);

    session.setForm(descriptor);
    session.setOpen(true);
    await session.ready();
    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);

    expect(input.value).toBe('alex@example.com');
    expect(session.snapshot().undoCount).toBe(1);

    // Simulate a host framework removing only our overlay: the content script
    // reuses this session and the freshly mounted UI receives its snapshot.
    const removeFirstOverlaySubscription = session.subscribe(() => undefined);
    removeFirstOverlaySubscription();
    session.setForm(descriptor);

    let remountedUndoCount = -1;
    const removeSecondOverlaySubscription = session.subscribe((state) => {
      remountedUndoCount = state.undoCount;
    });
    expect(remountedUndoCount).toBe(1);
    removeSecondOverlaySubscription();

    const undoClick = trustedShadowClick();
    session.undo(undoClick.event, undoClick.shadowRoot);
    expect(input.value).toBe('');
    expect(session.snapshot().undoCount).toBe(0);
  });

  it('pagehide 调用的 clearUndo 不会把旧页面的原值带入恢复路径', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const session = testSession();
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(session.snapshot().undoCount).toBe(1);

    session.clearUndo();
    const undoClick = trustedShadowClick();
    session.undo(undoClick.event, undoClick.shadowRoot);

    expect(session.snapshot().undoCount).toBe(0);
    expect(input.value).toBe('alex@example.com');
  });

  it('pagehide 在 policy pending 时取消本轮且恢复可重试预览', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    let resolvePolicy!: (policy: ReturnType<typeof createBundledApplyPolicy>) => void;
    const policy = new Promise<ReturnType<typeof createBundledApplyPolicy>>((resolve) => {
      resolvePolicy = resolve;
    });
    const session = testSession(() => policy);
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    const click = trustedShadowClick();
    const filling = session.fill(click.event, click.shadowRoot);
    expect(session.snapshot().phase).toBe('filling');

    session.clearUndo();
    expect(session.snapshot()).toMatchObject({ phase: 'idle', run: null, undoCount: 0 });
    expect(session.snapshot().summary?.willFill).toBe(1);

    resolvePolicy(createBundledApplyPolicy(Date.now()));
    await filling;

    expect(input.value).toBe('');
    expect(session.snapshot()).toMatchObject({ phase: 'idle', run: null, undoCount: 0 });
    expect(session.snapshot().summary?.willFill).toBe(1);
  });

  it('pagehide 在简历 resolver pending 时 abort signal，晚到文件也零写入零 journal', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="email">Email</label><input id="email" type="email" value="candidate@example.test" />
        <label for="resume">Resume/CV</label><input id="resume" type="file" />
      </form>`;
    const input = document.querySelector<HTMLInputElement>('#resume')!;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      width: 230,
      height: 40,
      top: 300,
      left: 0,
      right: 230,
      bottom: 340,
      x: 0,
      y: 300,
      toJSON: () => ({}),
    } as DOMRect);
    const changes = vi.fn();
    input.addEventListener('change', changes);
    let resolverSignal: AbortSignal | undefined;
    let resolveFile!: (file: File | null) => void;
    const pendingFile = new Promise<File | null>((resolve) => {
      resolveFile = resolve;
    });
    const session = createApplySession({
    hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'alex@example.test' }, readOnly: false },
      }),
      readResumeFileName: async () => 'Ada_Lovelace.pdf',
      resolveResumeFile: ({ signal }) => {
        resolverSignal = signal;
        // Deliberately ignore abort and settle late: the session must still
        // reject this stale continuation after pagehide invalidates its epoch.
        return pendingFile;
      },
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => readApplyForm('greenhouse'),
    });
    session.setForm(readApplyForm('greenhouse'));
    session.setOpen(true);
    await session.ready();
    await vi.waitFor(() =>
      expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['resumeFile']),
    );

    const click = trustedShadowClick();
    const filling = session.fill(click.event, click.shadowRoot);
    await vi.waitFor(() => expect(resolverSignal).toBeInstanceOf(AbortSignal));
    expect(resolverSignal?.aborted).toBe(false);

    session.clearUndo();
    expect(resolverSignal?.aborted).toBe(true);
    expect(session.snapshot()).toMatchObject({ phase: 'idle', run: null, undoCount: 0 });
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['resumeFile']);

    resolveFile(
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'Ada_Lovelace.pdf', {
        type: 'application/pdf',
      }),
    );
    await filling;

    expect(input.files).toHaveLength(0);
    expect(changes).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({ phase: 'idle', run: null, undoCount: 0 });
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['resumeFile']);
  });

  it('pagehide 立即取消 pending MAIN bridge，晚挂载 React handler 绝不再执行', async () => {
    vi.useFakeTimers();
    const removeMain = installMainWorldBridge(document, {
      retryDelayMs: 10,
      hydrateTimeoutMs: 1_000,
    });
    const input = document.createElement('input');
    document.body.appendChild(input);
    const descriptor = formFor(input);
    const actions: string[] = [];
    const onChange = vi.fn();
    input.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, (event) => {
      actions.push((event as CustomEvent<{ action: string }>).detail.action);
    });
    const session = createApplySession({
    hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'alex@example.test' }, readOnly: false },
      }),
      writeProfile: async () => ({ ok: true, value: undefined }),
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => descriptor,
      startMainWorldBridge: (target, authority, ticket) =>
        beginMainWorldReactChange(target, authority, ticket, { timeoutMs: 1_000 }),
    });

    try {
      session.setForm(descriptor);
      session.setOpen(true);
      await session.ready();
      const click = trustedShadowClick();
      let settled = false;
      const filling = session.fill(click.event, click.shadowRoot).then(() => {
        settled = true;
      });
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

      expect(actions).toEqual(['react-change']);
      expect(settled).toBe(false);
      session.clearUndo();
      await vi.advanceTimersByTimeAsync(0);

      expect(actions).toEqual(['react-change', 'cancel']);
      expect(settled, 'pagehide 后仍在等待 MAIN/C6 timeout').toBe(true);
      Object.defineProperty(input, '__reactProps$lateAfterPagehide', {
        configurable: true,
        value: { onChange },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onChange).not.toHaveBeenCalled();
      await filling;
      expect(session.snapshot()).toMatchObject({ phase: 'idle', run: null, undoCount: 0 });
    } finally {
      removeMain();
      session.dispose();
    }
  });

  it('同一表单重扫按控件实时值更新预览，不把已手填字段继续算作可填', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const session = testSession();
    const descriptor = formFor(input);
    session.setForm(descriptor);
    session.setOpen(true);
    await session.ready();
    expect(session.snapshot().summary?.willFill).toBe(1);

    input.value = 'candidate@example.test';
    session.setForm(descriptor);

    expect(session.snapshot().summary?.willFill).toBe(0);
    expect(session.snapshot().plan?.skipped).toEqual([
      { label: 'Email', reason: 'NOT_EMPTY', required: true, key: 'email', element: input, order: 0 },
    ]);
  });

  it('资料读取失败不会伪装成首次使用或留下 Fill 入口', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const session = createApplySession({
    hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({ ok: false, code: 'STORAGE_UNAVAILABLE' }),
      writeProfile: async () => ({ ok: true, value: undefined }),
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    expect(session.snapshot()).toMatchObject({
      profileStatus: 'unavailable',
      profileError: 'STORAGE_UNAVAILABLE',
      plan: null,
      firstRun: false,
    });
    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(input.value).toBe('');
    expect(session.snapshot().phase).toBe('idle');
  });

  it('资料保存失败保留编辑内容和已经提交的 Fill 预览', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const session = createApplySession({
    hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'alex@example.test' }, readOnly: false },
      }),
      writeProfile: async () => ({ ok: false, code: 'STORAGE_UNAVAILABLE' }),
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.setEditing(true);
    session.updateProfileField('city', 'San Francisco');

    await saveProfileFromShadow(session);

    expect(session.snapshot()).toMatchObject({
      profileStatus: 'ready',
      profileError: 'STORAGE_UNAVAILABLE',
      editing: true,
    });
    expect(session.snapshot().profile).toMatchObject({ city: 'San Francisco' });
    expect(session.snapshot().plan?.entries.map((entry) => entry.key)).toEqual(['email']);
  });

  it('refuses a synthetic event before it can save account-profile edits', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const writeProfile = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'account@example.test' }, revision: 1, suppressedKeys: [] },
      }),
      writeProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.updateProfileField('email', 'changed@example.test');

    const shadowRoot = trustedShadowClick().shadowRoot;
    await session.saveProfile(new Event('click', { bubbles: true, composed: true }), shadowRoot);

    expect(writeProfile).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({
      profileDirty: true,
      profile: { email: 'changed@example.test' },
    });
  });

  it('编辑草稿不会在保存前进入计划；PATCH 只拿到 touched 的三态字段', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const writeProfile = vi.fn(async (_draft, touched: readonly string[], revision: number) => {
      expect(touched).toEqual(['email']);
      expect(revision).toBe(7);
      return {
        ok: true as const,
        value: {
          draft: { email: 'new@example.test' },
          revision: 8,
          suppressedKeys: [],
        },
      };
    });
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'old@example.test' }, revision: 7, suppressedKeys: [] },
      }),
      writeProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    expect(session.snapshot().plan?.entries[0]?.value).toBe('old@example.test');

    session.updateProfileField('email', 'new@example.test');
    expect(session.snapshot().plan?.entries[0]?.value).toBe('old@example.test');

    await saveProfileFromShadow(session);
    expect(writeProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot().plan?.entries[0]?.value).toBe('new@example.test');
  });

  it('412 closes Fill and never auto-reloads or retries the stale write', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const readProfile = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { draft: { email: 'old@example.test' }, revision: 7, suppressedKeys: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { draft: { email: 'new@example.test' }, revision: 8, suppressedKeys: [] },
      });
    const writeProfile = vi.fn(async () => ({ ok: false as const, code: 'PROFILE_CONFLICT' as const }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile,
      writeProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.updateProfileField('email', 'candidate-edit@example.test');

    await saveProfileFromShadow(session);
    expect(session.snapshot()).toMatchObject({
      profileStatus: 'conflict',
      profileError: 'PROFILE_CONFLICT',
      plan: null,
      editing: true,
    });
    expect(writeProfile).toHaveBeenCalledTimes(1);
    expect(readProfile).toHaveBeenCalledTimes(1);

    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(input.value).toBe('');

    const reloadClick = trustedShadowClick();
    await session.reloadProfile(reloadClick.event, reloadClick.shadowRoot);
    expect(readProfile).toHaveBeenCalledTimes(2);
    expect(session.snapshot().profile).toMatchObject({ email: 'candidate-edit@example.test' });
    expect(session.snapshot().plan?.entries[0]?.value).toBe('new@example.test');
  });

  /**
   * 2026-08-10 对抗评审抓到的洞：新错误码 PROFILE_DELETION_CONFLICT 在 API 层分了流，
   * 却在 session 层**零消费**——只判 PROFILE_CONFLICT，删除冲突落进"瞬时失败、保留
   * 计划"那条分支。后果不是少一句提示：plan 会用**已被删除**的姓名/邮箱重建，
   * Fill 保持可点，用户一点就把自己刚删掉的资料写进雇主的申请表。
   *
   * 这条锁"删除冲突至少与并发冲突同等作废"，删掉 session 里那半个判断就必须变红。
   */
  it('删除冲突与并发冲突同等作废计划（服务端说这份档案已经不存在了）', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const readProfile = vi.fn(async () => ({
      ok: true as const,
      value: { draft: { email: 'old@example.test' }, revision: 7, suppressedKeys: [] },
    }));
    const writeProfile = vi.fn(async () => ({
      ok: false as const,
      code: 'PROFILE_DELETION_CONFLICT' as const,
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile,
      writeProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.updateProfileField('email', 'candidate-edit@example.test');

    await saveProfileFromShadow(session);
    expect(session.snapshot()).toMatchObject({
      profileStatus: 'conflict',
      profileError: 'PROFILE_DELETION_CONFLICT',
      plan: null,
      editing: true,
    });

    // 计划作废后 Fill 不得再写入任何东西。
    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(input.value, '删除冲突之后仍然填进了宿主表单').toBe('');
  });

  /**
   * 评审判定为最危险的一条：resume-derivation 这个接口在带上 expectedDeletionEpoch
   * **之前根本不可能返回 412**（请求体没有任何乐观锁），所以这条 412 分支是这次改动
   * **新造出来**的。而它原来的失败处理是"瞬时失败：保留计划、不置 dirty"——
   * 于是删除冲突之后 Fill 按钮仍然可点，用户一点就把已删除的资料写进雇主表单。
   */
  it('切换简历推导时撞上删除冲突，同样作废计划并关掉 Fill', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true as const,
        value: { draft: { email: 'old@example.test' }, revision: 7, suppressedKeys: [] },
      }),
      setResumeDerivation: async () => ({
        ok: false as const,
        code: 'PROFILE_DELETION_CONFLICT' as const,
      }),
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    expect(session.snapshot().plan, '前置：本该先有一个计划').not.toBeNull();

    const toggle = trustedShadowClick();
    await session.setResumeDerivation(false, toggle.event, toggle.shadowRoot);

    expect(session.snapshot()).toMatchObject({
      profileStatus: 'conflict',
      profileError: 'PROFILE_DELETION_CONFLICT',
      plan: null,
    });

    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(input.value, '删除冲突之后仍然填进了宿主表单').toBe('');
  });

  it('legacy migration state has no plan or exposed legacy values until an explicit upload succeeds', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const uploadLegacyProfile = vi.fn(async () => ({
      ok: true as const,
      value: { draft: { email: 'server@example.test' }, revision: 1, suppressedKeys: [] },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: {}, migration: 'migratable' as const },
      }),
      uploadLegacyProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    expect(session.snapshot()).toMatchObject({
      profileStatus: 'migration',
      profileMigration: 'migratable',
      profile: {},
      plan: null,
    });

    const uploadClick = trustedShadowClick();
    await session.uploadLegacyProfile(uploadClick.event, uploadClick.shadowRoot);
    expect(uploadLegacyProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot().plan?.entries[0]?.value).toBe('server@example.test');
  });

  it('resume facts stay outside the plan until the candidate explicitly accepts and saves one', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const readResumeSuggestions = vi.fn(async () => ({
      ok: true as const,
      value: { email: 'resume@example.test', linkedinUrl: 'https://linkedin.com/in/resume' },
    }));
    const writeProfile = vi.fn(async () => ({
      ok: true as const,
      value: { draft: { email: 'resume@example.test' }, revision: 2, suppressedKeys: [] },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'server@example.test' }, revision: 1, suppressedKeys: [] },
      }),
      readResumeSuggestions,
      writeProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.setEditing(true);
    expect(session.snapshot().plan?.entries[0]?.value).toBe('server@example.test');

    const importClick = trustedShadowClick();
    await session.loadResumeSuggestions(importClick.event, importClick.shadowRoot);
    expect(readResumeSuggestions).toHaveBeenCalledTimes(1);
    expect(session.snapshot().resumeSuggestions).toEqual({
      email: 'resume@example.test',
      linkedinUrl: 'https://linkedin.com/in/resume',
    });
    expect(session.snapshot().plan?.entries[0]?.value).toBe('server@example.test');

    const acceptClick = trustedShadowClick();
    session.acceptResumeSuggestion('email', acceptClick.event, acceptClick.shadowRoot);
    expect(session.snapshot().profile.email).toBe('resume@example.test');
    expect(session.snapshot().plan?.entries[0]?.value).toBe('server@example.test');

    await saveProfileFromShadow(session);
    expect(writeProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot().plan?.entries[0]?.value).toBe('resume@example.test');
  });

  it('filters a regressed structured response by server suppression and never lets its value enter the editor', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const readResumeSuggestions = vi.fn(async () => ({
      ok: true as const,
      value: { email: 'resume@example.test', phone: '+14155550123' },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: { email: 'server@example.test' },
          revision: 1,
          suppressedKeys: ['phone'],
          resumeDerivationEnabled: true,
        },
      }),
      readResumeSuggestions,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.setEditing(true);

    const click = trustedShadowClick();
    await session.loadResumeSuggestions(click.event, click.shadowRoot);
    expect(readResumeSuggestions).toHaveBeenCalledTimes(1);
    expect(session.snapshot().resumeSuggestions).toEqual({ email: 'resume@example.test' });

    session.acceptResumeSuggestion('phone', click.event, click.shadowRoot);
    expect(session.snapshot().profile.phone).toBeUndefined();
  });

  it('a server-owned ALL opt-out makes resume suggestion transport unreachable after deletion', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const readResumeSuggestions = vi.fn(async () => ({
      ok: true as const,
      value: { email: 'regressed-structured@example.test' },
    }));
    const deleteAccountProfile = vi.fn(async () => ({
      ok: true as const,
      value: {
        draft: {},
        revision: 0,
        hasStoredProfile: false,
        suppressedKeys: [],
        resumeDerivationEnabled: false,
      },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: { email: 'server@example.test' },
          revision: 1,
          suppressedKeys: [],
          resumeDerivationEnabled: true,
        },
      }),
      deleteAccountProfile,
      readResumeSuggestions,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.setConfirmingAccountDeletion(true);

    const click = trustedShadowClick();
    await session.deleteAccountProfile(click.event, click.shadowRoot);
    expect(deleteAccountProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot().profile).toEqual({});

    session.setEditing(true);
    await session.loadResumeSuggestions(click.event, click.shadowRoot);
    expect(readResumeSuggestions).not.toHaveBeenCalled();
    expect(session.snapshot().resumeSuggestionStatus).toBe('disabled');
  });

  it('an in-flight profile save blocks a Fill before a 412 can race its reviewed plan', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    let settleWrite!: (result: { ok: false; code: 'PROFILE_CONFLICT' }) => void;
    const writeProfile = vi.fn(
      () =>
        new Promise<{ ok: false; code: 'PROFILE_CONFLICT' }>((resolve) => {
          settleWrite = resolve;
        }),
    );
    const loadPolicy = vi.fn(async () => createBundledApplyPolicy(Date.now()));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'server@example.test' }, revision: 1, suppressedKeys: [] },
      }),
      writeProfile,
      loadPolicy,
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.updateProfileField('city', 'Seattle');

    const saving = saveProfileFromShadow(session);
    expect(session.snapshot().profileBusy).toBe(true);
    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(loadPolicy).not.toHaveBeenCalled();
    expect(input.value).toBe('');

    settleWrite({ ok: false, code: 'PROFILE_CONFLICT' });
    await saving;
    expect(session.snapshot()).toMatchObject({
      profileStatus: 'conflict',
      plan: null,
      phase: 'idle',
    });
  });

  it('a running Fill refuses the destructive account-delete action', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    let resolvePolicy!: (policy: ReturnType<typeof createBundledApplyPolicy>) => void;
    const policy = new Promise<ReturnType<typeof createBundledApplyPolicy>>((resolve) => {
      resolvePolicy = resolve;
    });
    const deleteAccountProfile = vi.fn(async () => ({
      ok: true as const,
      value: {
        draft: {},
        revision: 0,
        hasStoredProfile: false,
        suppressedKeys: [],
        resumeDerivationEnabled: false,
      },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'server@example.test' }, revision: 1, suppressedKeys: [] },
      }),
      deleteAccountProfile,
      loadPolicy: () => policy,
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    const click = trustedShadowClick();
    const filling = session.fill(click.event, click.shadowRoot);
    expect(session.snapshot().phase).toBe('filling');
    session.setConfirmingAccountDeletion(true);
    await session.deleteAccountProfile(click.event, click.shadowRoot);
    expect(deleteAccountProfile).not.toHaveBeenCalled();

    resolvePolicy(createBundledApplyPolicy(Date.now()));
    await filling;
    expect(input.value).toBe('server@example.test');
  });

  it('service-side profile deletion needs a second confirmation and cannot be reached by a plain UI call', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const deleteAccountProfile = vi.fn(async () => ({
      ok: true as const,
      value: {
        draft: {},
        revision: 0,
        hasStoredProfile: false,
        suppressedKeys: [],
        resumeDerivationEnabled: false,
      },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: { draft: { email: 'server@example.test' }, revision: 4, suppressedKeys: [] },
      }),
      deleteAccountProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    const click = trustedShadowClick();

    await session.deleteAccountProfile(click.event, click.shadowRoot);
    expect(deleteAccountProfile).not.toHaveBeenCalled();

    session.setConfirmingAccountDeletion(true);
    await session.deleteAccountProfile(click.event, click.shadowRoot);
    expect(deleteAccountProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      profile: {},
      confirmingAccountDeletion: false,
      firstRun: true,
    });
    expect(session.snapshot().plan?.entries).toEqual([]);
  });

  it('将本次读取的收紧 policy 原样交给最终写入边界', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const baseline = createBundledApplyPolicy(Date.now());
    const session = testSession(async () => ({ ...baseline, minConfidence: 0.9 }));
    // 0.8 still appears in the bundled 0.7 preview, so a LOW_CONFIDENCE
    // result proves the runner received this freshly loaded stricter policy.
    session.setForm(formFor(input, 0.8));
    session.setOpen(true);
    await session.ready();

    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);

    expect(input.value).toBe('');
    expect(session.snapshot()).toMatchObject({ phase: 'done', undoCount: 0 });
    expect(session.snapshot().run?.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'LOW_CONFIDENCE' },
    ]);
  });

  it('真实表单替换会清理旧 journal，绝不跨申请表恢复字段', async () => {
    const first = document.createElement('input');
    document.body.appendChild(first);
    const session = testSession();
    session.setForm(formFor(first));
    session.setOpen(true);
    await session.ready();
    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(session.snapshot().undoCount).toBe(1);

    const second = document.createElement('input');
    document.body.replaceChildren(second);
    session.setForm(formFor(second));

    expect(session.snapshot().undoCount).toBe(0);
    expect(session.snapshot().run).toBeNull();
    expect(first.value).toBe('alex@example.com');
  });

  it('dispose 后晚到 policy 不能在离页后写宿主字段', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    let resolvePolicy: ((policy: ReturnType<typeof createBundledApplyPolicy>) => void) | undefined;
    const policy = new Promise<ReturnType<typeof createBundledApplyPolicy>>((resolve) => {
      resolvePolicy = resolve;
    });
    const session = testSession(async () => policy);
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    const click = trustedShadowClick();
    const filling = session.fill(click.event, click.shadowRoot);
    session.dispose();
    resolvePolicy?.(createBundledApplyPolicy(Date.now()));
    await filling;

    expect(input.value).toBe('');
    expect(session.snapshot().undoCount).toBe(0);
  });

  it('C6 复核期间换表会恢复新表单预览，而非永久停在 filling', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const first = document.createElement('input');
    document.body.appendChild(first);
    let resolvePolicy: ((policy: ReturnType<typeof createBundledApplyPolicy>) => void) | undefined;
    const policy = new Promise<ReturnType<typeof createBundledApplyPolicy>>((resolve) => {
      resolvePolicy = resolve;
    });
    const session = testSession(async () => policy);
    session.setForm(formFor(first));
    session.setOpen(true);
    await session.ready();

    const click = trustedShadowClick();
    const filling = session.fill(click.event, click.shadowRoot);
    expect(session.snapshot().phase).toBe('filling');
    resolvePolicy?.(createBundledApplyPolicy(Date.now()));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.value).toBe('alex@example.com');

    const second = document.createElement('input');
    document.body.replaceChildren(second);
    session.setForm(formFor(second));
    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    await filling;

    const state = session.snapshot();
    expect(first.isConnected).toBe(false);
    expect(state.phase).toBe('idle');
    expect(state.form?.fields[0]?.element).toBe(second);
    expect(state.run).toBeNull();
    expect(state.undoCount).toBe(0);
    expect(state.summary?.willFill).toBe(1);
  });

  it('C6 pending 时 descriptor 扩展但已写节点仍连接，Undo 必须保留并可还原', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const email = document.createElement('input');
    document.body.appendChild(email);
    let resolvePolicy!: (policy: ReturnType<typeof createBundledApplyPolicy>) => void;
    const policy = new Promise<ReturnType<typeof createBundledApplyPolicy>>((resolve) => {
      resolvePolicy = resolve;
    });
    const session = testSession(() => policy);
    const initial = formFor(email);
    session.setForm(initial);
    session.setOpen(true);
    await session.ready();

    const click = trustedShadowClick();
    const filling = session.fill(click.event, click.shadowRoot);
    resolvePolicy(createBundledApplyPolicy(Date.now()));
    await vi.advanceTimersByTimeAsync(0);
    expect(email.value).toBe('alex@example.com');
    expect(session.snapshot().phase).toBe('filling');

    const added = document.createElement('input');
    document.body.appendChild(added);
    const expanded: ApplyFormDescriptor = {
      ...initial,
      fields: [
        ...initial.fields,
        {
          kind: 'text',
          key: 'firstName',
          label: 'First name',
          element: added,
          required: false,
          confidence: 1,
          signature: fieldSignature(added, initial.root),
        },
      ],
    };
    session.setForm(expanded);
    await filling;

    const state = session.snapshot();
    expect(email.isConnected).toBe(true);
    expect(state).toMatchObject({ phase: 'idle', run: null, undoCount: 1 });
    expect(state.form?.fields).toHaveLength(2);

    const undo = trustedShadowClick();
    session.undo(undo.event, undo.shadowRoot);
    expect(email.value).toBe('');
    expect(session.snapshot().undoCount).toBe(0);
  });

  it('C5 身份漂移会自动重扫同一表单，保留已验证写入的 Undo', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First name</label>
        <input id="first_name" name="job_application[first_name]" />
        <label for="last_name">Last name</label>
        <input id="last_name" name="job_application[last_name]" />
        <label for="email">Email</label>
        <input id="email" name="job_application[email]" />
      </form>
    `;
    const firstName = document.querySelector<HTMLInputElement>('#first_name')!;
    const lastName = document.querySelector<HTMLInputElement>('#last_name')!;
    const email = document.querySelector<HTMLInputElement>('#email')!;
    let rescanCount = 0;
    const session = createApplySession({
    hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: {
            firstName: 'Alex',
            lastName: 'Rivera',
            email: 'alex@example.test',
          },
          readOnly: false,
        },
      }),
      writeProfile: async () => ({ ok: true, value: undefined }),
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => {
        rescanCount += 1;
        return readApplyForm('greenhouse');
      },
    });
    const initial = readApplyForm('greenhouse');
    if (!initial) throw new Error('Greenhouse fixture unexpectedly failed to scan');
    session.setForm(initial);
    session.setOpen(true);
    await session.ready();

    firstName.addEventListener(
      'input',
      () => lastName.setAttribute('name', 'job_application[answers_attributes][new_question]'),
      { once: true },
    );
    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);

    const state = session.snapshot();
    // 2026-09-23 起漂移不连坐：身份变了的 lastName 一个字都不写，email 照常写；
    // 这一轮记下的漂移（identityDrift）照样触发重扫、重新给预览——新预览里只剩 lastName 要填。
    expect(rescanCount).toBe(1);
    expect(state.phase).toBe('idle');
    expect(state.run).toBeNull();
    expect(state.summary?.willFill).toBe(1);
    expect(state.undoCount).toBe(2);
    expect(firstName.value).toBe('Alex');
    expect(lastName.value).toBe('');
    expect(email.value).toBe('alex@example.test');

    const undoClick = trustedShadowClick();
    session.undo(undoClick.event, undoClick.shadowRoot);
    expect(firstName.value).toBe('');
    expect(email.value).toBe('');
    expect(session.snapshot().undoCount).toBe(0);
  });

  it('HOST_SUBMITTED 保留可见结果，不会把被取消的提交静默重扫掉', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="email">Email</label>
        <input id="email" name="job_application[email]" />
      </form>
    `;
    const form = readApplyForm('greenhouse');
    if (!form) throw new Error('Greenhouse fixture unexpectedly failed to scan');
    const hostForm = document.querySelector('form')!;
    const email = document.querySelector<HTMLInputElement>('#email')!;
    let rescanCount = 0;
    const session = testSession(undefined, () => {
      rescanCount += 1;
      return readApplyForm('greenhouse');
    });
    session.setForm(form);
    session.setOpen(true);
    await session.ready();
    email.addEventListener(
      'input',
      () => hostForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      { once: true },
    );

    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);

    const state = session.snapshot();
    expect(rescanCount).toBe(0);
    expect(state.phase).toBe('done');
    expect(state.run).toMatchObject({ abortedBy: 'HOST_SUBMITTED', failed: 1 });
    expect(state.undoCount).toBe(0);
  });

  it('account deletion retires a completed Fill ticket before it can replay deleted values', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const deleteAccountProfile = vi.fn(async () => ({
      ok: true as const,
      value: {
        draft: {},
        revision: 0,
        hasStoredProfile: false,
        suppressedKeys: [],
        resumeDerivationEnabled: false,
      },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: { email: 'deleted@example.test' },
          revision: 1,
          suppressedKeys: [],
          resumeDerivationEnabled: true,
        },
      }),
      deleteAccountProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    const fillClick = trustedShadowClick();
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(input.value).toBe('deleted@example.test');

    session.setConfirmingAccountDeletion(true);
    const deleteClick = trustedShadowClick();
    await session.deleteAccountProfile(deleteClick.event, deleteClick.shadowRoot);
    expect(deleteAccountProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot().plan).toBeNull();

    // A host can clear a field after our first Fill. The old ticket must not
    // remain callable through a future UI/control-flow change.
    input.value = '';
    await session.fill(fillClick.event, fillClick.shadowRoot);
    expect(input.value).toBe('');
  });

  it('drops a structured-resume response that arrives after account deletion', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    let resolveSuggestions!: (value: { ok: true; value: { email: string } }) => void;
    const pendingSuggestions = new Promise<{ ok: true; value: { email: string } }>((resolve) => {
      resolveSuggestions = resolve;
    });
    const deleteAccountProfile = vi.fn(async () => ({
      ok: true as const,
      value: {
        draft: {},
        revision: 0,
        hasStoredProfile: false,
        suppressedKeys: [],
        resumeDerivationEnabled: false,
      },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: { email: 'account@example.test' },
          revision: 1,
          suppressedKeys: [],
          resumeDerivationEnabled: true,
        },
      }),
      readResumeSuggestions: () => pendingSuggestions,
      deleteAccountProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.setEditing(true);

    const suggestionClick = trustedShadowClick();
    const loading = session.loadResumeSuggestions(suggestionClick.event, suggestionClick.shadowRoot);
    expect(session.snapshot().resumeSuggestionStatus).toBe('loading');

    session.setConfirmingAccountDeletion(true);
    const deleteClick = trustedShadowClick();
    await session.deleteAccountProfile(deleteClick.event, deleteClick.shadowRoot);
    resolveSuggestions({ ok: true, value: { email: 'pre-delete-resume@example.test' } });
    await loading;

    expect(session.snapshot()).toMatchObject({
      resumeSuggestionStatus: 'idle',
      resumeSuggestions: {},
      profile: {},
    });
  });

  it('revokes a pending resume review when the editor closes, then accepts only the new review', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    let resolveFirst!: (value: { ok: true; value: { email: string } }) => void;
    let resolveSecond!: (value: { ok: true; value: { email: string } }) => void;
    const first = new Promise<{ ok: true; value: { email: string } }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ ok: true; value: { email: string } }>((resolve) => {
      resolveSecond = resolve;
    });
    const readResumeSuggestions = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: { email: 'account@example.test' },
          revision: 1,
          suppressedKeys: [],
          resumeDerivationEnabled: true,
        },
      }),
      readResumeSuggestions,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.setEditing(true);

    const click = trustedShadowClick();
    const firstLoading = session.loadResumeSuggestions(click.event, click.shadowRoot);
    expect(session.snapshot().resumeSuggestionStatus).toBe('loading');

    session.setEditing(false);
    expect(session.snapshot()).toMatchObject({
      editing: false,
      resumeSuggestionStatus: 'idle',
      resumeSuggestions: {},
    });
    session.setEditing(true);
    const secondLoading = session.loadResumeSuggestions(click.event, click.shadowRoot);
    expect(readResumeSuggestions).toHaveBeenCalledTimes(2);
    expect(session.snapshot().resumeSuggestionStatus).toBe('loading');

    resolveFirst({ ok: true, value: { email: 'stale@example.test' } });
    await firstLoading;
    expect(session.snapshot().resumeSuggestionStatus).toBe('loading');

    resolveSecond({ ok: true, value: { email: 'current@example.test' } });
    await secondLoading;
    expect(session.snapshot()).toMatchObject({
      resumeSuggestionStatus: 'ready',
      resumeSuggestions: { email: 'current@example.test' },
    });
  });

  it('admits only one concurrent resume-review request from the session layer', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    let resolveSuggestions!: (value: { ok: true; value: { email: string } }) => void;
    const pendingSuggestions = new Promise<{ ok: true; value: { email: string } }>((resolve) => {
      resolveSuggestions = resolve;
    });
    const readResumeSuggestions = vi.fn(() => pendingSuggestions);
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: { email: 'account@example.test' },
          revision: 1,
          suppressedKeys: [],
          resumeDerivationEnabled: true,
        },
      }),
      readResumeSuggestions,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    session.setEditing(true);

    const firstClick = trustedShadowClick();
    const firstLoading = session.loadResumeSuggestions(firstClick.event, firstClick.shadowRoot);
    const secondClick = trustedShadowClick();
    await session.loadResumeSuggestions(secondClick.event, secondClick.shadowRoot);
    expect(readResumeSuggestions).toHaveBeenCalledTimes(1);

    resolveSuggestions({ ok: true, value: { email: 'reviewed@example.test' } });
    await firstLoading;
    expect(session.snapshot()).toMatchObject({
      resumeSuggestionStatus: 'ready',
      resumeSuggestions: { email: 'reviewed@example.test' },
    });
  });

  it('keeps an offline local deletion out of migration while still blocking Fill', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const discardLegacyProfile = vi.fn(async () => ({
      ok: false as const,
      code: 'LOGIN_REQUIRED' as const,
      legacyLocalDeleted: true as const,
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({ ok: true, value: { draft: {}, migration: 'migratable' as const } }),
      discardLegacyProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    const click = trustedShadowClick();
    await session.discardLegacyProfile(click.event, click.shadowRoot);

    expect(discardLegacyProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      profileStatus: 'unavailable',
      profileMigration: null,
      profileError: 'LOGIN_REQUIRED',
      plan: null,
    });
    await session.fill(click.event, click.shadowRoot);
    expect(input.value).toBe('');
  });

  it('does not let a migration transport error turn Reload into an account-profile bypass', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const readProfile = vi.fn(async () => ({
      ok: true as const,
      value: { draft: {}, migration: 'migratable' as const },
    }));
    const uploadLegacyProfile = vi.fn(async () => ({
      ok: false as const,
      code: 'LOGIN_REQUIRED' as const,
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile,
      uploadLegacyProfile,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();
    const click = trustedShadowClick();
    await session.uploadLegacyProfile(click.event, click.shadowRoot);
    expect(session.snapshot()).toMatchObject({
      profileStatus: 'migration',
      profileError: 'LOGIN_REQUIRED',
      plan: null,
    });

    await session.reloadProfile(click.event, click.shadowRoot);
    expect(readProfile).toHaveBeenCalledTimes(1);
    expect(session.snapshot().profileStatus).toBe('migration');
  });

  it('retains the 30-day local-deletion acknowledgement when the account is unavailable', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: false as const,
        code: 'LOGIN_REQUIRED' as const,
        migrationNotice: 'CLEARED_AFTER_30_DAYS' as const,
      }),
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    expect(session.snapshot()).toMatchObject({
      profileStatus: 'unavailable',
      profileMigration: null,
      profileMigrationNotice: 'CLEARED_AFTER_30_DAYS',
      plan: null,
    });
  });

  it('changes the long-lived resume-derivation setting only after an explicit Shadow gesture', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const setResumeDerivation = vi.fn(async (enabled: boolean) => ({
      ok: true as const,
      value: {
        draft: { email: 'account@example.test' },
        revision: 2,
        suppressedKeys: [],
        resumeDerivationEnabled: enabled,
      },
    }));
    const session = createApplySession({
      hostIsKnownAts: true,
      vendor: 'greenhouse',
      readProfile: async () => ({
        ok: true,
        value: {
          draft: { email: 'account@example.test' },
          revision: 1,
          suppressedKeys: [],
          resumeDerivationEnabled: false,
        },
      }),
      setResumeDerivation,
      loadPolicy: async () => createBundledApplyPolicy(Date.now()),
      rescanForm: () => null,
    });
    session.setForm(formFor(input));
    session.setOpen(true);
    await session.ready();

    await session.setResumeDerivation(true, new Event('click'), document.createElement('div').attachShadow({ mode: 'open' }));
    expect(setResumeDerivation).not.toHaveBeenCalled();

    const click = trustedShadowClick();
    await session.setResumeDerivation(true, click.event, click.shadowRoot);
    expect(setResumeDerivation).toHaveBeenCalledWith(true);
    expect(session.snapshot()).toMatchObject({
      resumeDerivationEnabled: true,
      profileBusy: false,
    });
  });
});
