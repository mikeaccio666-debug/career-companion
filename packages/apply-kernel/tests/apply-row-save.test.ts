import { afterEach, describe, expect, it } from 'vitest';

import { collectClickFacts } from '../src/click/facts';
import { clickHostTarget } from '../src/click/primitives';
import { buildApplyPlan } from '../src/engine';
import {
  captureTrustedShadowGesture,
  consumeAuthority,
  mintRowActionAuthorityFromGesture,
  mintRowAddAuthorityFromGesture,
  rowActionOfAuthority,
  type TrustedGestureProof,
} from '../src/grant';
import { readApplyForm } from '../src/registry';
import { installBundledApplyAdapters } from '../src/bundledAdapters';
import { parseApplyProfileCollections } from '../src/profileCollections';
import {
  clickAddRow,
  clickSaveRow,
  collectionsForRow,
  describeRowAdds,
  entryEditorState,
  entryPlanSlice,
  remainingEntries,
  rowAddAnchor,
  rowPlanSlice,
} from '../src/rowActions';
import { createUndoJournal } from '../src/undo';
import { parseVendorRuleset } from '../src/rules/schema';
import workableRules from '@edaix/apply-rules/workable.json';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import { mountWorkableEntrySections } from './fixtures/workable/entrySections';

installBundledApplyAdapters();

/**
 * 每一段要单独保存的区（2026-09-24 负责人：「workable，那就和jobright一样全加全存」）。
 *
 * 行专用票从「只许加一行」扩到「加一行，或按规则声明的那一颗『保存本段』」：一张票只许其中一种、点一下就用掉；
 * 删行永远铸不出来；远程策略的 `manage-rows` 位照旧逐次检查（fail closed）；点击照旧走 `clickHostTarget`
 * 的整张拒绝表——提交类控件（type=submit、省略 type 的表单内按钮、名字像提交的）一律点不了；这一下期间
 * 宿主若想提交或重置整张表，当场取消、这一下作废。
 *
 * 夹具是 Workable 线上结构的骨架（tests/fixtures/workable/entrySections.ts），没有任何账号数据。
 */

afterEach(() => { document.body.innerHTML = ''; });

function proof(): TrustedGestureProof {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let captured: TrustedGestureProof | null = null;
  button.addEventListener('click', (event) => { captured = captureTrustedShadowGesture(event, shadowRoot); });
  const event = new MouseEvent('click');
  Object.defineProperty(event, 'isTrusted', { value: true });
  button.dispatchEvent(event);
  expect(captured).not.toBeNull();
  return captured!;
}

function rowPolicy(manageRows: boolean) {
  const base = testApplyPolicy();
  return { ...base, capabilities: { ...base.capabilities, 'manage-rows': manageRows } };
}

const workable = () => {
  const read = readApplyForm('workable', document);
  expect(read, 'workable adapter should recognise the form').not.toBeNull();
  return read!;
};

function saveTicket() {
  const minted = mintRowActionAuthorityFromGesture({ proof: proof(), action: 'save' });
  if (!minted.ok) throw new Error(minted.code);
  return minted.value;
}

/** 打开一个经历编辑框，按「逐字符」的样子把 Title 填上（夹具只看 value）。 */
function openFilledEditor(title = 'Sample Title'): void {
  document.querySelector<HTMLButtonElement>('[data-ui="experience"] button[data-ui="add-section"]')!.click();
  const input = document.querySelector<HTMLInputElement>('[data-ui="experience"] [data-ui="editor"] input[name="title"]')!;
  input.value = title;
}

describe('行专用票：加一行或保存本段，一张票只许一种', () => {
  it('铸出来的票记着它许的那一种动作；删行铸不出来', () => {
    const add = mintRowActionAuthorityFromGesture({ proof: proof(), action: 'add' });
    const save = mintRowActionAuthorityFromGesture({ proof: proof(), action: 'save' });
    if (!add.ok || !save.ok) throw new Error('mint failed');
    expect(rowActionOfAuthority(add.value)).toBe('add');
    expect(rowActionOfAuthority(save.value)).toBe('save');
    expect(mintRowActionAuthorityFromGesture({ proof: proof(), action: 'remove' as never })).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    // 旧入口仍在，铸的就是加行票。
    const legacy = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!legacy.ok) throw new Error(legacy.code);
    expect(rowActionOfAuthority(legacy.value)).toBe('add');
    expect(rowActionOfAuthority(testAuthority(null, 'fill', ['set-text']))).toBeNull();
  });

  it('凭证伪造或过期：铸不出', () => {
    expect(mintRowActionAuthorityFromGesture({ proof: Object.freeze({ capturedAt: Date.now() }) as never, action: 'save' }))
      .toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
    const old = proof();
    expect(mintRowActionAuthorityFromGesture({ proof: old, action: 'save', now: Date.now() + 60_000 }))
      .toEqual({ ok: false, code: 'GESTURE_EXPIRED' });
  });

  it('保存票点不了加一行；加行票点不了保存（各自走 clickHostTarget 的票据检查）', () => {
    mountWorkableEntrySections(document, ['experience']);
    openFilledEditor();
    const root = workable().root;
    const save = document.querySelector('[data-ui="experience"] button[data-ui="save-section"]')!;
    const addTicket = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!addTicket.ok) throw new Error(addTicket.code);
    expect(consumeAuthority(addTicket.value).ok).toBe(true);
    const saveFacts = collectClickFacts({ element: save, root, kind: 'row-save', planned: true, declaredRowAction: 'save' });
    expect(clickHostTarget({ element: save, facts: saveFacts, root, authority: addTicket.value, ticket: createUndoJournal().recordStructuralAction(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });

    const ticket = saveTicket();
    expect(consumeAuthority(ticket).ok).toBe(true);
    const add = document.querySelector('[data-ui="experience"] button[data-ui="add-section"]')!;
    const addFacts = collectClickFacts({ element: add, root, kind: 'row-add', planned: true, declaredRowAction: 'add' });
    expect(clickHostTarget({ element: add, facts: addFacts, root, authority: ticket, ticket: createUndoJournal().recordStructuralAction(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    // 删行：保存票同样点不了。
    const removeFacts = collectClickFacts({ element: save, root, kind: 'row-remove', planned: true, declaredRowAction: 'remove' });
    expect(clickHostTarget({ element: save, facts: removeFacts, root, authority: ticket, ticket: createUndoJournal().recordStructuralAction(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
  });

  it('通用票带不出 manage-rows：点不了保存', () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    openFilledEditor();
    const generic = testAuthority(null, 'fill', ['set-text', 'manage-rows']);
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: generic, journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(host.openEditors('experience')).toBe(1);
  });
});

describe('把「保存本段」点出去（clickSaveRow）', () => {
  it('策略放行 + 保存票 + 这一行恰好一颗 Update → 那一段收成卡片；整张表没有提交', () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    openFilledEditor('Sample Title');
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: true, value: undefined });
    expect(host.openEditors('experience')).toBe(0);
    expect(host.savedTitles('experience')).toEqual(['Sample Title']);
    expect(host.submitted()).toBe(0);
  });

  it('远程策略没放行 manage-rows → CAPABILITY_DISABLED，一下都不点', () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    openFilledEditor();
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(false) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(host.openEditors('experience')).toBe(1);
  });

  it('加行票点不了保存', () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    openFilledEditor();
    const addTicket = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!addTicket.ok) throw new Error(addTicket.code);
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: addTicket.value, journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(host.openEditors('experience')).toBe(1);
  });

  it('那一行里没有保存钮、或有两颗、或行不存在 → CLICK_DENIED', () => {
    mountWorkableEntrySections(document, ['experience']);
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
    openFilledEditor();
    const editor = document.querySelector('[data-ui="experience"] [data-ui="editor"]')!;
    editor.insertAdjacentHTML('beforeend', '<button data-ui="save-section" type="button">Update</button>');
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect(clickSaveRow({ descriptor: workable(), collection: 'education', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
  });

  it('保存钮是 type=submit、或在表单里省略了 type → 点击策略拒（提交围栏不变），整张表没有提交', () => {
    for (const shape of ['submit', null] as const) {
      const host = mountWorkableEntrySections(document, ['experience']);
      openFilledEditor();
      const save = document.querySelector('[data-ui="experience"] button[data-ui="save-section"]')!;
      if (shape === null) save.removeAttribute('type');
      else save.setAttribute('type', shape);
      expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }), String(shape))
        .toEqual({ ok: false, code: 'CLICK_DENIED' });
      expect(host.openEditors('experience')).toBe(1);
      expect(host.submitted()).toBe(0);
    }
  });

  it('名字像提交的保存钮（「Save and continue」「Submit」）→ 拒', () => {
    for (const name of ['Save and continue', 'Submit']) {
      const host = mountWorkableEntrySections(document, ['experience']);
      openFilledEditor();
      document.querySelector('[data-ui="experience"] button[data-ui="save-section"]')!.textContent = name;
      expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }), name)
        .toEqual({ ok: false, code: 'CLICK_DENIED' });
      expect(host.openEditors('experience')).toBe(1);
    }
  });

  it('被禁用、藏起来的保存钮 → 拒', () => {
    for (const mutate of [(button: HTMLButtonElement) => { button.disabled = true; }, (button: HTMLButtonElement) => { button.hidden = true; }]) {
      const host = mountWorkableEntrySections(document, ['experience']);
      openFilledEditor();
      mutate(document.querySelector<HTMLButtonElement>('[data-ui="experience"] button[data-ui="save-section"]')!);
      expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }))
        .toEqual({ ok: false, code: 'CLICK_DENIED' });
      expect(host.openEditors('experience')).toBe(1);
    }
  });

  it('宿主在我们这一下里想提交整张表：当场取消，这一下作废（ABORTED），表单没有提交', () => {
    const host = mountWorkableEntrySections(document, ['experience'], { submitOnSave: true });
    // 表单里的必填都有值：宿主那一下 requestSubmit() 过得了约束校验，真的会派出 submit。
    (document.getElementById('firstname') as HTMLInputElement).value = 'Taylor';
    openFilledEditor();
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'ABORTED' });
    expect(host.submitted()).toBe(0);
  });

  it('一张票只点一下', () => {
    mountWorkableEntrySections(document, ['experience']);
    openFilledEditor();
    const ticket = saveTicket();
    const journal = createUndoJournal();
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: ticket, journal, policy: rowPolicy(true) }).ok).toBe(true);
    openFilledEditor();
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: ticket, journal, policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'GRANT_CONSUMED' });
  });
});

describe('编辑框在哪一行、这一段保存成了没有（entryEditorState）', () => {
  it('Workable 把新编辑框插在最前面：开着的是第 0 行，已保存的卡片挪到后面', () => {
    const host = mountWorkableEntrySections(document, ['experience']);
    expect(entryEditorState(workable(), 'experience')).toEqual({ rows: 0, open: [] });
    openFilledEditor('First');
    expect(entryEditorState(workable(), 'experience')).toEqual({ rows: 1, open: [0] });
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }).ok).toBe(true);
    expect(entryEditorState(workable(), 'experience')).toEqual({ rows: 1, open: [] });
    const addTicket = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!addTicket.ok) throw new Error(addTicket.code);
    expect(clickAddRow({ descriptor: workable(), collection: 'experience', authority: addTicket.value, journal: createUndoJournal(), policy: rowPolicy(true) }).ok).toBe(true);
    expect(entryEditorState(workable(), 'experience')).toEqual({ rows: 2, open: [0] });
    expect(host.savedTitles('experience')).toEqual(['First']);
  });

  it('区不在这一页、或没声明保存钮的区：没有编辑框可言', () => {
    mountWorkableEntrySections(document, ['experience']);
    expect(entryEditorState(workable(), 'education')).toEqual({ rows: 0, open: [] });
  });
});

describe('这一行填资料里的第几段（collectionsForRow）', () => {
  const THREE = parseApplyProfileCollections({
    experiences: [
      { company: 'Company A', title: 'Title A' },
      { company: 'Company B', title: 'Title B' },
      { company: 'Company C', title: 'Title C' },
    ],
  });

  it('第 0 行投影资料里的第 3 段；别的行、别的集合一概没有值', () => {
    const view = collectionsForRow(THREE, 'experience', 0, 2);
    expect(view.experiences?.[0]).toMatchObject({ company: 'Company C', title: 'Title C' });
    expect(view.experiences?.[1]).toBeUndefined();
    expect(view.educations ?? []).toEqual([]);
    const later = collectionsForRow(THREE, 'experience', 2, 0);
    expect(later.experiences?.[2]).toMatchObject({ company: 'Company A' });
    expect(later.experiences?.[0]).toBeUndefined();
    expect(collectionsForRow(THREE, 'experience', 0, 7).experiences?.[0]).toBeUndefined();
  });

  it('两个区的第 0 行都开着编辑框：按这个区的行元素切，另一个区的格一格都不进来', () => {
    mountWorkableEntrySections(document, ['experience', 'education']);
    document.querySelector<HTMLButtonElement>('[data-ui="education"] button[data-ui="add-section"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-ui="experience"] button[data-ui="add-section"]')!.click();
    const descriptor = workable();
    const both = parseApplyProfileCollections({ experiences: [{ company: 'Company A', title: 'Title A' }], educations: [{ school: 'School One' }] });
    const plan = buildApplyPlan(descriptor, { firstName: 'Taylor' }, { collections: collectionsForRow(both, 'experience', 0, 0) });
    expect(rowPlanSlice(plan, descriptor, 0).skipped.some((skip) => skip.key === 'education.school'), '只按行序切会把教育那一格也切进来').toBe(true);
    const slice = entryPlanSlice(plan, descriptor, 'experience', 0);
    expect(slice.entries.map((entry) => entry.key)).toEqual(['experience.title', 'experience.company']);
    expect(slice.skipped.every((skip) => String(skip.key).startsWith('experience.'))).toBe(true);
    expect(entryPlanSlice(plan, descriptor, 'experience', 3)).toMatchObject({ entries: [], skipped: [] });
  });

  it('没加上的几段在浮层上定位到这个区自己的「加一行」；区不在这一页就没有', () => {
    mountWorkableEntrySections(document, ['experience']);
    expect(rowAddAnchor(workable(), 'experience')).toBe(document.querySelector('[data-ui="experience"] button[data-ui="add-section"]'));
    expect(rowAddAnchor(workable(), 'education')).toBeNull();
  });

  it('编辑框插在最前面、要填的是第 2 段：计划切片只拿到第 2 段的值', () => {
    mountWorkableEntrySections(document, ['experience']);
    openFilledEditor('Title A');
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }).ok).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-ui="experience"] button[data-ui="add-section"]')!.click();
    const descriptor = workable();
    const editor = entryEditorState(descriptor, 'experience').open[0]!;
    expect(editor).toBe(0);
    const plan = buildApplyPlan(descriptor, { firstName: 'Taylor' }, { collections: collectionsForRow(THREE, 'experience', editor, 1) });
    const slice = rowPlanSlice(plan, descriptor, editor);
    expect(slice.entries.map((entry) => [entry.key, entry.value])).toEqual([
      ['experience.title', 'Title B'],
      ['experience.company', 'Company B'],
    ]);
  });
});

/**
 * 页面上最后从上到下要是资料的顺序（2026-09-24 负责人：招聘方从上往下读，最近的一段在最上面）。Workable 把每一段
 * 新编辑框插在最前面：按资料顺序加，页面上就倒过来了（测试台实测 skroutz 六段是倒的）。规则在行作用域上声明
 * `insertsAt: "top"`，内核就从资料的最后一段加起。为什么是规则数据而不是内核自己看：一个空的区加第一段时，看不出
 * 宿主往哪一头插——等第二段露出来，第一段放在哪儿已经定了。
 */
describe('插在最前面的区：从资料的最后一段加起，页面上最后是资料的顺序', () => {
  const SIX = parseApplyProfileCollections({
    experiences: Array.from({ length: 6 }, (_, index) => ({ company: `Company ${index}`, title: `Title ${index}` })),
    educations: [{ school: 'School One' }, { school: 'School Two' }],
  });

  it('Workable 的两个区都声明了 insertsAt: top', () => {
    const scopes = (workableRules as { rowScopes: readonly { collection: string; insertsAt?: string }[] }).rowScopes;
    expect(scopes.map((scope) => [scope.collection, scope.insertsAt])).toEqual([['experience', 'top'], ['education', 'top']]);
  });

  it('下一段取资料里还没加的最后一段；已有几段就往前数几段', () => {
    mountWorkableEntrySections(document, ['experience']);
    expect(describeRowAdds(workable(), SIX, new Set(['education'])).next).toEqual({ collection: 'experience', rowIndex: 0, entryIndex: 5 });
    openFilledEditor('Title 5');
    expect(clickSaveRow({ descriptor: workable(), collection: 'experience', rowIndex: 0, authority: saveTicket(), journal: createUndoJournal(), policy: rowPolicy(true) }).ok).toBe(true);
    expect(describeRowAdds(workable(), SIX, new Set(['education'])).next).toEqual({ collection: 'experience', rowIndex: 1, entryIndex: 4 });
    expect(remainingEntries(workable(), SIX, 'experience')).toEqual({ from: 0, to: 4 });
  });

  it('接在最后的区（Greenhouse）照旧：第 N 段接在第 N 行，还没加的是后面几段', () => {
    document.body.innerHTML = `<form id="application-form"><label for="first_name">First name</label><input id="first_name" type="text" />
      <div class="education--container"><div class="education--form"><label for="school--0">School</label><input id="school--0" type="text" /></div>
      <button type="button" class="add-another-button">Add another</button></div></form>`;
    const greenhouse = readApplyForm('greenhouse', document)!;
    expect(describeRowAdds(greenhouse, SIX).next).toEqual({ collection: 'education', rowIndex: 1, entryIndex: 1 });
    expect(remainingEntries(greenhouse, SIX, 'education')).toEqual({ from: 1, to: 1 });
  });

  it('规则：insertsAt 只认 top / bottom；top 只许配每一段要单独保存的区（没有保存钮就找不到插在最前面的新行）', () => {
    const withScope = (patch: Record<string, unknown>) => {
      const rules = structuredClone(workableRules) as { rowScopes: Record<string, unknown>[] };
      rules.rowScopes[0] = { ...rules.rowScopes[0], ...patch };
      return parseVendorRuleset(rules);
    };
    expect(withScope({}).ok).toBe(true);
    expect(withScope({ insertsAt: 'bottom' }).ok).toBe(true);
    expect(withScope({ insertsAt: 'middle' })).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    expect(withScope({ actions: { add: 'button[data-ui="add-section"]' } })).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    expect(withScope({ actions: { add: 'button[data-ui="add-section"]' }, insertsAt: 'bottom' }).ok).toBe(true);
  });
});
