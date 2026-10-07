// @vitest-environment happy-dom
import type { CandidateProfileSnapshotV2, PatchCandidateProfileV2 } from '@edaix/contracts';
import { describe, expect, it, vi } from 'vitest';

import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { mountAutofillDock } from '../lib/autofillDock';

/**
 * 浮层里的「我的资料」（设计 18 号画面）：直接改、直接存到门户上的资料（2026-09-23 负责人）。
 *
 * 钉住三件事：打开才去读（挂上时不碰资料）；改了的项在保存栏里数得出来；保存只发改过的那一格，
 * 过的是与门户同一份 Profile V2 PATCH。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function mount() {
  const snapshot = fictionalProfileSnapshot('Example Person')!;
  const saved: PatchCandidateProfileV2[] = [];
  const directory = {
    profileV2: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    saveProfileV2: vi.fn(async (patch: PatchCandidateProfileV2) => {
      saved.push(patch);
      const next = JSON.parse(JSON.stringify(snapshot)) as { revision: string; profile: { identity: { firstName: string | null } } };
      next.revision = '2';
      next.profile.identity.firstName = (patch.fields?.['identity.firstName'] as string | undefined) ?? next.profile.identity.firstName;
      return { ok: true as const, value: next as unknown as CandidateProfileSnapshotV2 };
    }),
  };
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {}, directory }, doc);
  return { handle, directory, saved };
}

describe('我的资料：在浮层里改、存到门户', () => {
  it('挂上浮层时不读资料；点「我的资料」才读，并摆出基本资料那一栏', async () => {
    const { handle, directory } = mount();
    expect(directory.profileV2).not.toHaveBeenCalled();
    click(handle.entryButtons()[0]);
    await settle();
    expect(directory.profileV2).toHaveBeenCalledTimes(1);
    expect(handle.scene()).toBe('PROFILE');
    const root = handle.profileRoot();
    expect(root?.querySelector('[data-pf-sec="basic"] .pf-sec-title')?.textContent).toBe('基本资料');
    expect(root?.querySelector('.pf-status')?.textContent).toBe('所有修改都已保存');
  });

  it('改名：保存栏数出 1 项；保存只发 identity.firstName 这一格', async () => {
    const { handle, directory, saved } = mount();
    click(handle.entryButtons()[0]);
    await settle();
    const root = handle.profileRoot()!;
    const first = root.querySelector<HTMLInputElement>('input[data-pf="first"]')!;
    first.value = 'Sam';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('.pf-status')?.textContent).toBe('1 项修改未保存');
    click(root.querySelector('[data-action="profile-save"]'));
    await settle();
    expect(directory.saveProfileV2).toHaveBeenCalledTimes(1);
    expect(saved[0]?.fields).toEqual({ 'identity.firstName': 'Sam' });
  });

  it('名空着：不保存，具体说哪一项', async () => {
    const { handle, directory } = mount();
    click(handle.entryButtons()[0]);
    await settle();
    const root = handle.profileRoot()!;
    const first = root.querySelector<HTMLInputElement>('input[data-pf="first"]')!;
    first.value = ' ';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    click(root.querySelector('[data-action="profile-save"]'));
    await settle();
    expect(directory.saveProfileV2).not.toHaveBeenCalled();
    expect(root.querySelector('[data-pf-field="first"] .pf-err')?.textContent).toBe('请填写名。');
  });

  it('教育经历里有「在读」：打开后「结束」那一格改叫「预计毕业」，保存时在读、预计毕业都存上并确认（2026-10-03 后端体检第四节）', async () => {
    const { handle, saved } = mount();
    click(handle.entryButtons()[0]);
    await settle();
    const root = handle.profileRoot()!;
    const entry = root.querySelector('[data-pf-sec="edu"] .pf-entry');
    click(entry?.querySelector('.pf-entry-head'));
    const toggle = root.querySelector<HTMLButtonElement>('[data-pf-field="edu.0.current"] [role="switch"]');
    expect(toggle, '在读那一格看得见').not.toBeNull();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    const endLabel = () => root.querySelector('[data-pf-field="edu.0.to"] .pf-label')?.textContent;
    expect(endLabel()).toBe('结束');
    click(toggle);
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(endLabel(), '在读：那一格是预计毕业').toBe('预计毕业');
    const to = root.querySelector<HTMLInputElement>('[data-pf-field="edu.0.to"] input')!;
    expect(to.disabled, '预计毕业照样能填').toBe(false);
    to.value = '2027-05';
    to.dispatchEvent(new Event('input', { bubbles: true }));
    expect(entry?.querySelector('.pf-entry-sub')?.textContent, '条目副标题写预计毕业，不写「至今」').toContain('预计 2027.05');
    click(root.querySelector('[data-action="profile-save"]'));
    await settle();
    const row = saved[0]?.educations?.[0];
    expect(row?.isCurrent).toBe(true);
    expect(row?.endDate).toBeNull();
    expect(row?.expectedGraduationDate).toEqual({ year: 2027, month: 5 });
    expect(row?.confirmFields).toContain('isCurrent');
  });

  it('保存到点没答（TIMEOUT）：照实说不确定存上没有，改的东西都还在（2026-10-04）', async () => {
    const snapshot = fictionalProfileSnapshot('Example Person')!;
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      saveProfileV2: vi.fn(async () => ({ ok: false as const, code: 'TIMEOUT' as const })),
    };
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {}, directory }, doc);
    click(handle.entryButtons()[0]);
    await settle();
    const root = handle.profileRoot()!;
    const first = root.querySelector<HTMLInputElement>('input[data-pf="first"]')!;
    first.value = 'Sam';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    const toastNode = (root.getRootNode() as ShadowRoot).querySelector('[data-toast]');
    click(root.querySelector('[data-action="profile-save"]'));
    await settle();
    await settle();
    expect(toastNode?.textContent).toBe('Career Companion 这次回得太慢，不确定存上没有。你的修改还在，稍后再点一次保存。');
    expect(root.querySelector('.pf-status')?.textContent, '改的东西还在').toBe('1 项修改未保存');
    expect(directory.profileV2, '没有整份重读').toHaveBeenCalledTimes(1);
  });

  it('有没保存的修改就离开：先问「离开前要保存吗？」', async () => {
    const { handle } = mount();
    click(handle.entryButtons()[0]);
    await settle();
    const root = handle.profileRoot()!;
    const first = root.querySelector<HTMLInputElement>('input[data-pf="first"]')!;
    first.value = 'Sam';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    handle.backHome();
    expect(handle.scene(), '没问就不走').toBe('PROFILE');
    expect(root.querySelector<HTMLElement>('.pf-confirm')?.dataset.show).toBe('true');
    expect(root.querySelector('.pf-confirm-title')?.textContent).toBe('有 1 项修改还没保存');
    click(root.querySelector('.pf-confirm-discard'));
    expect(handle.scene()).toBe('HOME');
  });
});

describe('代填授权（2026-09-28，文案版本 application-signing-2026-09-28）', () => {
  it('那一格是负责人定稿的一句话；下面一行点开隐私政策里写明范围的那一节', async () => {
    const snapshot = fictionalProfileSnapshot('Example Person')!;
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      saveProfileV2: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    };
    const signing = { load: vi.fn(async () => ({ ok: true as const, value: false })), set: vi.fn(async (granted: boolean) => ({ ok: true as const, value: granted })) };
    const opened: string[] = [];
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock(
      { kind: 'UNAVAILABLE', reason: 'NO_MISSION' },
      { onAutofill: () => {}, onOpenEntry: () => {}, directory, profilePorts: { signing }, onOpenPortal: (page) => { opened.push(page); } },
      doc,
    );
    click(handle.entryButtons()[0]);
    await settle();
    const section = handle.profileRoot()?.querySelector('[data-pf-sec="consent"]');
    expect(section?.textContent).toContain('允许 ArgoLand 以我的名义处理申请表上的条款、声明和授权，并替我注册、登录招聘网站。详见隐私政策。');
    const link = section?.querySelector<HTMLButtonElement>('.pf-cap-link');
    expect(link?.textContent).toContain('在隐私政策里查看代填的范围');
    click(link);
    expect(opened).toEqual(['SIGNING_SCOPE_ZH']);
  });
});

describe('保存抛了（2026-10-04 体检 3a-4 / 吞掉的错第 6 条）', () => {
  it('不再卡住：「保存」照旧按得了、也离得开资料页；说没存上，交一个稳定码（只有类名）', async () => {
    const snapshot = fictionalProfileSnapshot('Example Person')!;
    const boom = new TypeError('patch exploded with student@example.com');
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      // 当场就抛（不是交回一个被拒的 promise）：persist 那一段从前没人接，saving 一直是 true。
      saveProfileV2: vi.fn(() => { throw boom; }) as never,
    };
    const onError = vi.fn();
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock(
      { kind: 'UNAVAILABLE', reason: 'NO_MISSION' },
      { onAutofill: () => {}, onOpenEntry: () => {}, directory, onError },
      doc,
    );
    click(handle.entryButtons()[0]);
    await settle();
    const root = handle.profileRoot()!;
    const first = root.querySelector<HTMLInputElement>('input[data-pf="first"]')!;
    first.value = 'Sam';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    click(root.querySelector('[data-action="profile-save"]'));
    await settle();
    await settle();
    expect(onError).toHaveBeenCalledWith('PROFILE_SAVE_THREW', boom);
    expect((root.getRootNode() as ShadowRoot).querySelector('.toast')?.textContent).toContain('暂时保存不了，请稍后再试。');
    // 还能再按一次「保存」（从前 saving 一直是 true，这一下什么都不会发生）。
    click(root.querySelector('[data-action="profile-save"]'));
    await settle();
    expect(directory.saveProfileV2).toHaveBeenCalledTimes(2);
  });
});

describe('浮层的按钮抛了（2026-10-04 体检 11-2）', () => {
  it('交一个稳定码（DOCK_HANDLER_THREW，只有类名），照旧抛出；不装全页的 error 监听', async () => {
    const onError = vi.fn();
    const boom = new RangeError('handler exploded');
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock(
      { kind: 'UNAVAILABLE', reason: 'NO_MISSION' },
      { onAutofill: () => {}, onOpenEntry: () => { throw boom; }, onError },
      doc,
    );
    const thrown: unknown[] = [];
    const button = handle.entryButtons()[1]!;
    try {
      button.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    } catch (error) {
      thrown.push(error);
    }
    await settle();
    expect(onError).toHaveBeenCalledWith('DOCK_HANDLER_THREW', boom);
  });
});
