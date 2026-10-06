import { afterEach, describe, expect, it } from 'vitest';

import { mergeAuditViews, type AuditView } from '../src/audit';
import { collectClickFacts } from '../src/click/facts';
import { clickHostTarget } from '../src/click/primitives';
import { buildApplyPlan } from '../src/engine';
import { consumeAuthority, mintRowAddAuthorityFromGesture, captureTrustedShadowGesture, isRowAddOnlyAuthority } from '../src/grant';
import { readApplyForm } from '../src/registry';
import { installBundledApplyAdapters } from '../src/bundledAdapters';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { clickAddRow, describeRowAdds, presentRowCounts, rowEntries, rowNeedsSave, rowPlanSlice, rowSaveControl } from '../src/rowActions';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

installBundledApplyAdapters();

/**
 * 增删行编排的执行侧（P1-8b）：数行、说下一步、把「加一行」点出去。
 *
 * 钉的是四道闸：远程策略的 manage-rows 位（fail closed）、加行专用票只许 row-add（反过来
 * 通用票也点不了加行）、控件必须恰好一个、以及点完由调用方重扫——本模块不自己加满。
 */

afterEach(() => { document.body.innerHTML = ''; });

function educationRow(index: number): string {
  return `
    <div class="education--form">
      <label for="school--${index}">School</label><input id="school--${index}" type="text" />
      <label for="discipline--${index}">Discipline</label><input id="discipline--${index}" type="text" />
    </div>`;
}

function mount(rows: number, withAdd = true): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name</label><input id="first_name" type="text" />
      <div class="education--container">
        ${Array.from({ length: rows }, (_, index) => educationRow(index)).join('')}
        ${withAdd ? '<button type="button" class="add-another-button">Add another</button>' : ''}
      </div>
    </form>`;
}

/** 宿主的行为：点「加一行」就在按钮前插一行。 */
function hostAddsRows(): void {
  const button = document.querySelector<HTMLButtonElement>('.add-another-button')!;
  button.addEventListener('click', () => {
    const count = document.querySelectorAll('.education--form').length;
    button.insertAdjacentHTML('beforebegin', educationRow(count));
  });
}

const TWO = parseApplyProfileCollections({
  educations: [{ school: 'Example University', fieldOfStudy: 'Design' }, { school: 'Second College', fieldOfStudy: 'History' }],
});

function descriptor() {
  const read = readApplyForm('greenhouse', document);
  expect(read, 'greenhouse adapter should recognise the form').not.toBeNull();
  return read!;
}

function proof() {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let captured: ReturnType<typeof captureTrustedShadowGesture> = null;
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

describe('数行与说下一步', () => {
  it('按规则的容器与行选择器数页面此刻的行', () => {
    mount(1);
    expect(presentRowCounts(descriptor())).toEqual({ education: 1 });
    mount(3);
    expect(presentRowCounts(descriptor())).toEqual({ education: 3 });
  });

  it('档案两段、页面一行 → 下一步给教育加第 2 行；页面两行 → 不用再加', () => {
    mount(1);
    expect(describeRowAdds(descriptor(), TWO).next).toEqual({ collection: 'education', rowIndex: 1, entryIndex: 1 });
    mount(2);
    expect(describeRowAdds(descriptor(), TWO).next).toBeNull();
  });

  it('描述符带着规则的行作用域：这是选择器进 kernel 的唯一通道', () => {
    mount(1);
    expect(descriptor().rowScopes?.some((rule) => rule.collection === 'education' && rule.actions?.add !== undefined)).toBe(true);
  });
});

describe('把「加一行」点出去', () => {
  it('策略放行 + 专用票 + 恰好一个控件 → 宿主真的多了一行', () => {
    mount(1);
    hostAddsRows();
    const minted = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!minted.ok) throw new Error(minted.code);
    expect(isRowAddOnlyAuthority(minted.value)).toBe(true);
    const result = clickAddRow({ descriptor: descriptor(), collection: 'education', authority: minted.value, journal: createUndoJournal(), policy: rowPolicy(true) });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(document.querySelectorAll('.education--form')).toHaveLength(2);
  });

  it('策略没放行 manage-rows → CAPABILITY_DISABLED，一下都不点', () => {
    mount(1);
    hostAddsRows();
    const minted = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!minted.ok) throw new Error(minted.code);
    expect(clickAddRow({ descriptor: descriptor(), collection: 'education', authority: minted.value, journal: createUndoJournal(), policy: rowPolicy(false) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(document.querySelectorAll('.education--form')).toHaveLength(1);
  });

  it('页面上没有「加一行」控件 → CLICK_DENIED；两个也拒', () => {
    mount(1, false);
    const first = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!first.ok) throw new Error(first.code);
    expect(clickAddRow({ descriptor: descriptor(), collection: 'education', authority: first.value, journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
    mount(1);
    document.querySelector('.education--container')!.insertAdjacentHTML('beforeend', '<button type="button" class="add-another-button">Add another</button>');
    const second = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!second.ok) throw new Error(second.code);
    expect(clickAddRow({ descriptor: descriptor(), collection: 'education', authority: second.value, journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
  });

  it('通用手势票带不出 manage-rows，点不了加行', () => {
    mount(1);
    hostAddsRows();
    const generic = testAuthority(null, 'fill', ['set-text', 'manage-rows']);
    expect(clickAddRow({ descriptor: descriptor(), collection: 'education', authority: generic, journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(document.querySelectorAll('.education--form')).toHaveLength(1);
  });

  it('加行专用票反过来也点不了别的：分段保存、下拉都拒', () => {
    mount(1);
    document.querySelector('.education--container')!.insertAdjacentHTML('beforeend', '<button type="button" class="save-section">Save</button>');
    const minted = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!minted.ok) throw new Error(minted.code);
    expect(consumeAuthority(minted.value).ok).toBe(true);
    const root = descriptor().root;
    const save = document.querySelector('.save-section')!;
    const facts = collectClickFacts({ element: save, root, kind: 'row-save', planned: true, declaredRowAction: 'save' });
    expect(clickHostTarget({ element: save, facts, root, authority: minted.value, ticket: createUndoJournal().recordStructuralAction(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
  });

  it('专用票一次一用：点过就消费掉', () => {
    mount(1);
    hostAddsRows();
    const minted = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!minted.ok) throw new Error(minted.code);
    const journal = createUndoJournal();
    expect(clickAddRow({ descriptor: descriptor(), collection: 'education', authority: minted.value, journal, policy: rowPolicy(true) }).ok).toBe(true);
    expect(clickAddRow({ descriptor: descriptor(), collection: 'education', authority: minted.value, journal, policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'GRANT_CONSUMED' });
  });
});

describe('新行的条目与视图合并', () => {
  it('重扫后的计划只取第 2 行的行内条目', () => {
    mount(2);
    const next = descriptor();
    const plan = buildApplyPlan(next, { firstName: 'Taylor' }, { collections: TWO });
    const entries = rowEntries(plan, next, 1);
    expect(entries.map((entry) => [entry.key, entry.value])).toEqual([
      ['education.school', 'Second College'],
      ['education.fieldOfStudy', 'History'],
    ]);
  });

  it('计划切片：条目与跳过项都只留新行的——第 1 行已填的格不再记成「已预填」', () => {
    mount(2);
    (document.getElementById('school--0') as HTMLInputElement).value = 'Example University';
    const next = descriptor();
    const plan = buildApplyPlan(next, { firstName: 'Taylor' }, { collections: parseApplyProfileCollections({ educations: [{ school: 'Example University' }, { school: 'Second College' }] }) });
    const slice = rowPlanSlice(plan, next, 1);
    expect(slice.entries.map((entry) => [entry.key, entry.value])).toEqual([['education.school', 'Second College']]);
    expect(slice.skipped.map((skip) => [skip.key, skip.reason])).toEqual([['education.fieldOfStudy', 'NO_VALUE']]);
  });

  it('结构动作票据：日志可用就发，撤销进行中不发', () => {
    const journal = createUndoJournal();
    expect(journal.recordStructuralAction().ok).toBe(true);
    expect(journal.canUndo(), '结构票据不进撤销条目').toBe(false);
  });

  it('视图合并：行拼接，计数按同一口径重算', () => {
    const row = (label: string, status: AuditView['rows'][number]['status'], required = true): AuditView['rows'][number] =>
      ({ key: 'education.school', label, required, status, reason: null, attemptedValue: 'x', resolvedOptionText: null, element: document.createElement('input'), confidence: 1, order: 0 });
    const merged = mergeAuditViews([
      { rows: [row('School', 'FILLED')], filled: 1, requiredTotal: 1, requiredHandled: 1, needsAttention: 0, blockedByUs: 0, awaitingUser: 0 },
      { rows: [row('School', 'FAILED'), row('Discipline', 'NEEDS_MANUAL', false)], filled: 0, requiredTotal: 1, requiredHandled: 0, needsAttention: 2, blockedByUs: 1, awaitingUser: 1 },
    ]);
    expect(merged.rows.map((item) => item.status)).toEqual(['FILLED', 'FAILED', 'NEEDS_MANUAL']);
    expect(merged).toMatchObject({ filled: 1, requiredTotal: 2, requiredHandled: 1, blockedByUs: 1, awaitingUser: 1, needsAttention: 2 });
  });
});

/**
 * Workable 的形状（2026-09-24 测试台 apply.workable.com/skroutz/j/DB1A13AC0A/apply/）：经历与教育两个区，
 * 各有一颗同样的 `button[data-ui="add-section"]`「+ Add」；点了之后区里的 `ul` 多一个 `li`，里面是一个编辑框
 * （Title 必填、Company、Industry、Summary、起止日期、「I currently work here」），填完要点框里的「Update」
 * （`button[data-ui="save-section"]`）这一段才算成立。
 */
describe('Workable 那种：每个区一颗「加一行」，每一段要单独保存', () => {
  function mountWorkable(): void {
    document.body.innerHTML = `
      <form data-ui="application-form">
        <label>First name<input name="firstname" type="text" /></label>
        <div data-ui="experience"><p id="experience_label">Experience (Optional)</p>
          <button data-ui="add-section" aria-label="Add Experience" type="button">+ Add</button><ul></ul></div>
        <div data-ui="education"><p id="education_label">Education (Optional)</p>
          <button data-ui="add-section" aria-label="Add Education" type="button">+ Add</button><ul></ul></div>
      </form>`;
    for (const section of document.querySelectorAll('[data-ui="experience"], [data-ui="education"]')) {
      const list = section.querySelector('ul')!;
      section.querySelector('button')!.addEventListener('click', () => {
        list.insertAdjacentHTML('beforeend', `<li><div data-ui="editor">
          <label><span id="title_label">Title</span><input name="title" type="text" required /></label>
          <label><span>Company</span><input name="company" type="text" /></label>
          <button type="button" data-ui="save-section">Update</button>
          <button type="button" data-ui="cancel-section">Cancel</button></div></li>`);
      });
    }
  }
  const workable = () => {
    const read = readApplyForm('workable', document);
    expect(read, 'workable adapter should recognise the form').not.toBeNull();
    return read!;
  };
  const SIX = parseApplyProfileCollections({
    experiences: Array.from({ length: 6 }, (_, index) => ({ company: `Company ${index}`, title: `Title ${index}` })),
    educations: [{ school: 'Example University' }],
  });

  it('点的是这个区自己的那一颗「加一行」：两个区各有一颗同样的按钮也不算歧义', () => {
    mountWorkable();
    const minted = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!minted.ok) throw new Error(minted.code);
    expect(clickAddRow({ descriptor: workable(), collection: 'experience', authority: minted.value, journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: true, value: undefined });
    expect(document.querySelectorAll('[data-ui="experience"] li')).toHaveLength(1);
    expect(document.querySelectorAll('[data-ui="education"] li')).toHaveLength(0);
  });

  it('每一段要单独保存的区：认得出来，也找得到那一段自己的保存钮', () => {
    mountWorkable();
    expect(rowNeedsSave(workable(), 'experience')).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-ui="experience"] button')!.click();
    const save = rowSaveControl(workable(), 'experience', 0);
    expect(save?.textContent).toBe('Update');
    expect(rowSaveControl(workable(), 'experience', 1)).toBeNull();
    mount(1);
    expect(rowNeedsSave(descriptor(), 'education'), 'Greenhouse 加完行直接能填，不用保存').toBe(false);
  });

  /**
   * skroutz 实测：这一页只有经历区。从前在整张表里数「加一行」恰好一颗，于是给**教育**加行的那一下点在了
   * 经历区的按钮上——编辑框开在经历区、里面空着，我们还以为教育区「点了没反应」。
   */
  it('这一页没有的区：不给它加行，也绝不借用别的区的「加一行」', () => {
    mountWorkable();
    document.querySelector('[data-ui="education"]')!.remove();
    expect(describeRowAdds(workable(), SIX).next).toEqual({ collection: 'experience', rowIndex: 0, entryIndex: 5 });
    const minted = mintRowAddAuthorityFromGesture({ proof: proof() });
    if (!minted.ok) throw new Error(minted.code);
    expect(clickAddRow({ descriptor: workable(), collection: 'education', authority: minted.value, journal: createUndoJournal(), policy: rowPolicy(true) }))
      .toEqual({ ok: false, code: 'CLICK_DENIED' });
    expect(document.querySelectorAll('[data-ui="experience"] li')).toHaveLength(0);
  });

  it('跳过已经加过一段的区：下一步去加另一个区', () => {
    mountWorkable();
    expect(describeRowAdds(workable(), SIX).next).toEqual({ collection: 'education', rowIndex: 0, entryIndex: 0 });
    expect(describeRowAdds(workable(), SIX, new Set(['education'])).next).toEqual({ collection: 'experience', rowIndex: 0, entryIndex: 5 });
    expect(describeRowAdds(workable(), SIX, new Set(['education', 'experience'])).next).toBeNull();
  });
});
