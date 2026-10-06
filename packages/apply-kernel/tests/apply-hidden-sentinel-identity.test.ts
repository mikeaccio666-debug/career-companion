import { afterEach, describe, expect, it } from 'vitest';
import { fieldSignature } from '../src/fieldIdentity';
import {
  CONTROL_SELECTOR,
  createScanRoot,
  resolveScanRootMutationPolicy,
  sealScanRootMutationPolicy,
} from '../src/scanRoot';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';

/**
 * 真实 Greenhouse 页面实测（2026-09-10，33 个公开 job-boards 页面，零外发）：
 * react-select 在 `required` 且尚无值时渲染一个 `<input aria-hidden="true"
 * tabindex="-1" required>` 占位框，选中值后立即删掉它。电话控件写入会让国家
 * 下拉获得值，占位框消失，之后所有字段的"行内序号"整体前移一格——
 * identity recheck 对下一个字段报 IDENTITY_CHANGED，整轮中止；
 * 突变快照同样把这次删除当成语义变化。
 *
 * 辅助技术看不见的占位控件不是用户面对的字段，不应参与身份序号，
 * 它的出现或消失也不应让已审预览失效。真实控件的增删仍必须触发 fail closed。
 */
afterEach(() => {
  document.body.innerHTML = '';
});

function mountGreenhouseWithReactSelectSentinel(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      <div class="select-shell">
        <label for="country">Country*</label>
        <input id="country" type="text" role="combobox" aria-expanded="false" />
        <input id="sentinel" aria-hidden="true" tabindex="-1" required value="" />
      </div>
      <label for="phone">Phone*</label>
      <input id="phone" type="tel" required />
      <label for="linkedin">LinkedIn Profile</label>
      <input id="linkedin" type="text" />
    </form>`;
}

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

describe('aria-hidden sentinel controls and field identity', () => {
  it('removing a react-select sentinel does not shift later field signatures', () => {
    mountGreenhouseWithReactSelectSentinel();
    const root = greenhouseAdapter.resolveRoot(document);
    expect(root).not.toBeNull();
    const before = fieldSignature(byId('linkedin'), root!);
    const phoneBefore = fieldSignature(byId('phone'), root!);

    byId('sentinel').remove();

    expect(fieldSignature(byId('linkedin'), root!)).toEqual(before);
    expect(fieldSignature(byId('phone'), root!)).toEqual(phoneBefore);
  });

  it('removing a real control still changes later field signatures', () => {
    mountGreenhouseWithReactSelectSentinel();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const before = fieldSignature(byId('linkedin'), root);

    byId('phone').remove();

    expect(fieldSignature(byId('linkedin'), root).core).not.toBe(before.core);
  });

  it('sentinel churn is not a semantically relevant mutation and keeps the preview current', () => {
    mountGreenhouseWithReactSelectSentinel();
    const container = byId('application-form');
    const root = createScanRoot(container, []);
    root.querySelectorAll(CONTROL_SELECTOR);
    expect(sealScanRootMutationPolicy(root)).not.toBeNull();
    const policy = resolveScanRootMutationPolicy(root)!;
    const sentinel = byId('sentinel');
    const shell = sentinel.parentElement!;

    sentinel.remove();
    expect(policy.isRelevant([{
      type: 'childList',
      target: shell,
      addedNodes: [],
      removedNodes: [sentinel],
    } as unknown as MutationRecord])).toBe(false);
    expect(policy.isCurrent()).toBe(true);

    const reinserted = document.createElement('input');
    reinserted.setAttribute('aria-hidden', 'true');
    reinserted.setAttribute('tabindex', '-1');
    shell.append(reinserted);
    expect(policy.isRelevant([{
      type: 'childList',
      target: shell,
      addedNodes: [reinserted],
      removedNodes: [],
    } as unknown as MutationRecord])).toBe(false);
    expect(policy.isCurrent()).toBe(true);
  });

  it('an aria-hidden control that stays in the tab order is still a field, so its required change fails closed', () => {
    // Only aria-hidden="true" together with tabindex="-1" is a sentinel; this one keeps its
    // tab stop, so the scanner keeps it as a descriptor and its semantics still count.
    mountGreenhouseWithReactSelectSentinel();
    const container = byId('application-form');
    const hiddenButTabbable = document.createElement('input');
    hiddenButTabbable.id = 'preferred_name';
    hiddenButTabbable.setAttribute('aria-hidden', 'true');
    container.append(hiddenButTabbable);
    const root = createScanRoot(container, []);
    root.querySelectorAll(CONTROL_SELECTOR);
    sealScanRootMutationPolicy(root);
    const policy = resolveScanRootMutationPolicy(root)!;
    expect(policy.isCurrent()).toBe(true);

    hiddenButTabbable.setAttribute('required', '');
    expect(policy.isRelevant([{
      type: 'attributes',
      target: hiddenButTabbable,
      attributeName: 'required',
    } as unknown as MutationRecord])).toBe(true);
    expect(policy.isCurrent()).toBe(false);
  });

  it('a sentinel that re-enters the tab order becomes a field and fails closed', () => {
    mountGreenhouseWithReactSelectSentinel();
    const container = byId('application-form');
    const root = createScanRoot(container, []);
    root.querySelectorAll(CONTROL_SELECTOR);
    sealScanRootMutationPolicy(root);
    const policy = resolveScanRootMutationPolicy(root)!;
    const sentinel = byId('sentinel');

    sentinel.setAttribute('tabindex', '0');
    expect(policy.isRelevant([{
      type: 'attributes',
      target: sentinel,
      attributeName: 'tabindex',
    } as unknown as MutationRecord])).toBe(true);
    expect(policy.isCurrent()).toBe(false);
  });

  it('removing a real control remains a relevant mutation that fails closed', () => {
    mountGreenhouseWithReactSelectSentinel();
    const container = byId('application-form');
    const root = createScanRoot(container, []);
    root.querySelectorAll(CONTROL_SELECTOR);
    sealScanRootMutationPolicy(root);
    const policy = resolveScanRootMutationPolicy(root)!;
    const phone = byId('phone');

    phone.remove();
    expect(policy.isRelevant([{
      type: 'childList',
      target: container,
      addedNodes: [],
      removedNodes: [phone],
    } as unknown as MutationRecord])).toBe(true);
    expect(policy.isCurrent()).toBe(false);
  });
});
