// @vitest-environment happy-dom
import type { CandidateProfileSnapshotV2, PatchCandidateProfileV2 } from '@edaix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { mountAutofillDock } from '../lib/autofillDock';
import type { DockProfileCached, DockProfileEditorPorts } from '../lib/dock/profileEditorPorts';

/**
 * 「我的资料」的新鲜度（2026-10-03 前端体检 3.1／3.4，负责人要求 P0／P1 全修）：
 *
 * - 先显示旧的、后台换新：每次打开不再转一两秒；读到新的无缝换上，读不到照旧显示上一份并照实说。
 * - 别处刚存过（412）：不再整份重读、丢掉他手上的修改——重读最新的一版、把他改的逐项放上去再存；只有同一项两边都改了
 *   才请他选。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); }); };

afterEach(() => { document.body.innerHTML = ''; });

type Snapshot = CandidateProfileSnapshotV2;
/** 同一个人，revision 与几栏不同。 */
function version(revision: string, change: (profile: Record<string, any>) => void = () => {}): Snapshot {
  const raw = JSON.parse(JSON.stringify(fictionalProfileSnapshot('Example Person'))) as { revision: string; profile: Record<string, any> };
  raw.revision = revision;
  raw.profile.identity.firstName = 'Example';
  raw.profile.identity.lastName = 'Person';
  raw.profile.contact.email = 'example.person@example.test';
  raw.profile.contact.phone = { countryCode: '+1', e164: '+14155550100', display: '415 555 0100', type: null };
  change(raw.profile);
  return raw as unknown as Snapshot;
}
/** 一个可以手动放行的答复。 */
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

function mountWith(directory: { profileV2: () => Promise<any>; saveProfileV2: (patch: PatchCandidateProfileV2) => Promise<any> }, ports?: DockProfileEditorPorts) {
  const handle = mountAutofillDock(
    { kind: 'UNAVAILABLE', reason: 'NO_MISSION' },
    { onAutofill: () => {}, onOpenEntry: () => {}, directory: directory as never, ...(ports === undefined ? {} : { profilePorts: ports }) },
    document,
  );
  const root = () => handle.profileRoot()!;
  const status = () => root().querySelector('.pf-status')?.textContent ?? '';
  const input = (key: string) => root().querySelector<HTMLInputElement>(`input[data-pf="${key}"]`)!;
  const type = (key: string, value: string) => {
    const node = input(key);
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toast = () => (root().getRootNode() as ShadowRoot).querySelector('[data-toast]')?.textContent ?? '';
  return { handle, root, status, input, type, toast, open: () => click(handle.entryButtons()[0]), save: () => click(root().querySelector('[data-action="profile-save"]')) };
}

describe('别处刚存过（412）：他改的不丢（2026-10-03 体检 3.4）', () => {
  it('重读最新的一版，把他改的那一项放上去再存一次：不要他再改一遍，别处改的电话也留着', async () => {
    const reads = [version('1'), version('2', (p) => { p.contact.phone.display = '415 555 0199'; p.contact.phone.e164 = '+14155550199'; })];
    const saved: PatchCandidateProfileV2[] = [];
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: reads.shift() ?? version('2') })),
      saveProfileV2: vi.fn(async (patch: PatchCandidateProfileV2) => {
        saved.push(patch);
        if (saved.length === 1) return { ok: false as const, code: 'STALE' as const };
        return { ok: true as const, value: version('3', (p) => { p.identity.firstName = 'Sam'; p.contact.phone.display = '415 555 0199'; }) };
      }),
    };
    const ui = mountWith(directory);
    ui.open();
    await settle();
    ui.type('first', 'Sam');
    ui.save();
    await settle();
    expect(directory.saveProfileV2).toHaveBeenCalledTimes(2);
    expect(saved[1]?.expectedRevision, '第二次带着最新的 revision').toBe('2');
    expect(saved[1]?.fields, '只发他改的那一项，别处改的电话不被盖回去').toEqual({ 'identity.firstName': 'Sam' });
    expect(ui.input('first').value).toBe('Sam');
    expect(ui.status()).not.toContain('未保存');
    expect(ui.toast()).toBe('资料刚在别处改过：已把你的修改放到最新的一版上保存。');
  });

  it('同一项两边都改了、改得不一样：只为那一项请他选；选「别处的」，其余他改的照存', async () => {
    const reads = [version('1'), version('2', (p) => { p.identity.firstName = 'Alex'; })];
    const saved: PatchCandidateProfileV2[] = [];
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: reads.shift() ?? version('2') })),
      saveProfileV2: vi.fn(async (patch: PatchCandidateProfileV2) => {
        saved.push(patch);
        return saved.length === 1
          ? { ok: false as const, code: 'STALE' as const }
          : { ok: true as const, value: version('3', (p) => { p.identity.firstName = 'Alex'; p.address.city = 'Oakland'; }) };
      }),
    };
    const ui = mountWith(directory);
    ui.open();
    await settle();
    ui.type('first', 'Sam');
    ui.type('city', 'Oakland');
    ui.save();
    await settle();
    expect(directory.saveProfileV2, '有冲突就先不存').toHaveBeenCalledTimes(1);
    const card = ui.root().querySelector<HTMLElement>('.pf-conflict');
    expect(card?.dataset.show).toBe('true');
    const rows = Array.from(card!.querySelectorAll('.pf-conflict-row'));
    expect(rows, '只列两边都改了的那一项').toHaveLength(1);
    expect(rows[0]!.querySelector('.pf-conflict-label')?.textContent).toBe('名');
    const mine = rows[0]!.querySelector<HTMLButtonElement>('[data-pick="MINE"]')!;
    const theirs = rows[0]!.querySelector<HTMLButtonElement>('[data-pick="THEIRS"]')!;
    expect(mine.textContent).toBe('你刚改的：Sam');
    expect(theirs.textContent).toBe('别处的：Alex');
    const go = card!.querySelector<HTMLButtonElement>('[data-action="conflict-save"]')!;
    expect(go.disabled, '每一项都选了才能存').toBe(true);
    click(theirs);
    expect(go.disabled).toBe(false);
    click(go);
    await settle();
    expect(directory.saveProfileV2).toHaveBeenCalledTimes(2);
    expect(saved[1]?.expectedRevision).toBe('2');
    expect(saved[1]?.fields, '名留别处的，城市照存他的').toEqual({ 'address.city': 'Oakland' });
    expect(card?.dataset.show).toBe('false');
    expect(ui.input('first').value).toBe('Alex');
  });

  it('关掉选择框不选：他改的都还在；再按保存，那张卡又出来，不会悄悄盖掉别处的', async () => {
    const reads = [version('1'), version('2', (p) => { p.identity.firstName = 'Alex'; })];
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: reads.shift() ?? version('2') })),
      saveProfileV2: vi.fn(async () => ({ ok: false as const, code: 'STALE' as const })),
    };
    const ui = mountWith(directory);
    ui.open();
    await settle();
    ui.type('first', 'Sam');
    ui.save();
    await settle();
    const card = ui.root().querySelector<HTMLElement>('.pf-conflict')!;
    click(card.querySelector('[data-action="conflict-cancel"]'));
    expect(card.dataset.show).toBe('false');
    expect(ui.input('first').value).toBe('Sam');
    ui.save();
    await settle();
    expect(card.dataset.show).toBe('true');
    expect(directory.saveProfileV2).toHaveBeenCalledTimes(1);
  });

  it('重读也读不到：他改的都还在，照实说，不整份重读', async () => {
    let reads = 0;
    const directory = {
      profileV2: vi.fn(async () => (++reads === 1 ? { ok: true as const, value: version('1') } : { ok: false as const, code: 'UNAVAILABLE' as const })),
      saveProfileV2: vi.fn(async () => ({ ok: false as const, code: 'STALE' as const })),
    };
    const ui = mountWith(directory);
    ui.open();
    await settle();
    ui.type('first', 'Sam');
    ui.save();
    await settle();
    expect(ui.toast()).toBe('资料刚在别处改过，暂时读不到最新的一版。你的修改还在，稍后再保存一次。');
    expect(ui.input('first').value).toBe('Sam');
    expect(ui.status()).toBe('1 项修改未保存');
  });
});

describe('先显示旧的、后台换新（2026-10-03 体检 3.1）', () => {
  it('再打开一次：上一次的那一份当场就在，不转圈；底栏说「正在更新…」；读到新的就换上', async () => {
    const second = gate<{ ok: true; value: Snapshot }>();
    let reads = 0;
    const directory = {
      profileV2: vi.fn(() => (++reads === 1 ? Promise.resolve({ ok: true as const, value: version('1') }) : second.promise)),
      saveProfileV2: vi.fn(),
    };
    const ui = mountWith(directory);
    ui.open();
    await settle();
    ui.handle.backHome();
    ui.open();
    expect(ui.root().querySelector('.pf-message'), '没有整页转圈').toBeNull();
    expect(ui.input('first').value).toBe('Example');
    expect(ui.status()).toBe('正在更新…');
    second.release({ ok: true, value: version('2', (p) => { p.identity.firstName = 'Alex'; }) });
    await settle();
    expect(ui.input('first').value, '读到的新的一份换上了').toBe('Alex');
    expect(ui.status()).toBe('所有修改都已保存');
  });

  it('第一次打开：插件里存着上一次读到的就先显示它（只读 storage.session 里这个账号的那一份）', async () => {
    const live = gate<{ ok: true; value: Snapshot }>();
    const cached: DockProfileCached = {
      at: Date.now() - 3 * 60_000,
      profile: version('1'),
      eeo: { ok: false, code: 'NO_CACHE' },
      consent: { ok: true, value: true },
      resumes: { ok: false, code: 'NO_CACHE' },
    };
    const directory = { profileV2: vi.fn(() => live.promise), saveProfileV2: vi.fn() };
    const ui = mountWith(directory, { cached: vi.fn(async () => cached) });
    ui.open();
    await settle();
    expect(ui.root().querySelector('.pf-message')).toBeNull();
    expect(ui.input('first').value).toBe('Example');
    expect(ui.status()).toBe('正在更新…');
    expect(ui.root().querySelector('[data-pf-sec="eeo"]')?.textContent, '还没读到的那一节说正在读，不说读不到').toContain('正在读取…');
    live.release({ ok: true, value: version('2', (p) => { p.address.city = 'Berkeley'; }) });
    await settle();
    expect(ui.input('city').value).toBe('Berkeley');
    expect(ui.status()).toBe('所有修改都已保存');
  });

  it('后台没读到：照旧显示上一次的那一份，照实说没能更新、是多久以前读到的，可以重试', async () => {
    let reads = 0;
    const cached: DockProfileCached = {
      at: Date.now() - 3 * 60_000, profile: version('1'),
      eeo: { ok: false, code: 'NO_CACHE' }, consent: { ok: false, code: 'NO_CACHE' }, resumes: { ok: false, code: 'NO_CACHE' },
    };
    const directory = {
      profileV2: vi.fn(async () => (++reads === 1 ? { ok: false as const, code: 'TIMEOUT' as const } : { ok: true as const, value: version('2', (p) => { p.identity.firstName = 'Alex'; }) })),
      saveProfileV2: vi.fn(),
    };
    const ui = mountWith(directory, { cached: vi.fn(async () => cached) });
    ui.open();
    await settle();
    expect(ui.input('first').value).toBe('Example');
    expect(ui.status()).toContain('没能更新，这是 3 分钟前读到的资料');
    click(ui.root().querySelector('[data-action="profile-recheck"]'));
    await settle();
    expect(ui.input('first').value).toBe('Alex');
    expect(ui.status()).toBe('所有修改都已保存');
  });

  it('后台读到新的时他已经在改：他改的合上去，别处改的也换上', async () => {
    const live = gate<{ ok: true; value: Snapshot }>();
    const cached: DockProfileCached = {
      at: Date.now(), profile: version('1'),
      eeo: { ok: false, code: 'NO_CACHE' }, consent: { ok: false, code: 'NO_CACHE' }, resumes: { ok: false, code: 'NO_CACHE' },
    };
    const directory = { profileV2: vi.fn(() => live.promise), saveProfileV2: vi.fn() };
    const ui = mountWith(directory, { cached: vi.fn(async () => cached) });
    ui.open();
    await settle();
    ui.type('first', 'Sam');
    live.release({ ok: true, value: version('2', (p) => { p.address.city = 'Berkeley'; }) });
    await settle();
    expect(ui.input('first').value).toBe('Sam');
    expect(ui.input('city').value).toBe('Berkeley');
    expect(ui.status()).toBe('1 项修改未保存');
  });
});

describe('存到一半换了账号（2026-10-04）：上一个人的修改绝不存进下一个人的资料', () => {
  it('撞上 412 正要重读、合上去再存时换了人：停下，不重读、不再存，照实说没存', async () => {
    let releaseSave!: (value: { ok: false; code: 'STALE' }) => void;
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: version('1') })),
      saveProfileV2: vi.fn(() => new Promise((resolve) => { releaseSave = resolve; })),
    };
    const ui = mountWith(directory);
    ui.open();
    await settle();
    ui.type('first', 'Sam');
    ui.save();
    await settle();
    ui.handle.forgetUser();
    releaseSave({ ok: false, code: 'STALE' });
    await settle();
    expect(directory.saveProfileV2, '不再存').toHaveBeenCalledTimes(1);
    expect(ui.toast()).toBe('已经换了账号登录：这些修改没有存。');
    expect(ui.root().querySelector<HTMLInputElement>('input[data-pf="first"]')?.value, '编辑器里是新的人重读的那一份').toBe('Example');
  });

  it('worker 说已经换了人（SESSION_CHANGED）：照实说没存', async () => {
    const directory = {
      profileV2: vi.fn(async () => ({ ok: true as const, value: version('1') })),
      saveProfileV2: vi.fn(async () => ({ ok: false as const, code: 'SESSION_CHANGED' as const })),
    };
    const ui = mountWith(directory);
    ui.open();
    await settle();
    ui.type('first', 'Sam');
    ui.save();
    await settle();
    expect(ui.toast()).toBe('已经换了账号登录：这些修改没有存。');
    expect(directory.saveProfileV2).toHaveBeenCalledTimes(1);
  });
});
