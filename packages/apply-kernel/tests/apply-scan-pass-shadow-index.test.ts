import { afterEach, describe, expect, it } from 'vitest';

import generic from '@edaix/apply-rules/generic.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { CONTROL_SELECTOR, createScanRoot, withScanPass } from '../src/scanRoot';

/**
 * 一次同步扫描之内共用一份影子根索引（2026-09-28，通用路探测耗时）。
 *
 * lab 在 Jane Street、D. E. Shaw 的申请页上录 CPU：通用探测 135–150ms（生产预算 50ms），七成花在
 * `chrome.dom.openOrClosedShadowRoot` 上——每一次穿透查询都把范围里每个元素问一遍，一次扫描发生
 * 「字段数 × 元素数」次。这里数打开器被问了多少次，并锁住三件事：一拍之内每个元素只问一次；拍子里与
 * 拍子外查到的是同一组元素、同一个顺序；拍子一结束就不再用旧索引（写入期的复核照旧活查）。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const FIELDS = 40;

function mountForm(): HTMLFormElement {
  const rows = Array.from({ length: FIELDS }, (_, index) => {
    const label = ['First name', 'Last name', 'Email', 'Phone'][index] ?? `Question ${index}`;
    return `<div class="row"><div class="cell"><label for="f${index}">${label}</label><span class="hint">Hint</span><input id="f${index}" type="text"></div></div>`;
  }).join('');
  document.body.innerHTML = `<form id="application">${rows}</form>`;
  return document.querySelector('form')!;
}

function countingOpener() {
  let calls = 0;
  return {
    open: (element: Element): ShadowRoot | null => {
      calls += 1;
      return element.shadowRoot;
    },
    calls: () => calls,
  };
}

describe('一拍之内每个元素只问一次影子根', () => {
  it('通用路的一次探测（找表 + 扫描）：问的次数与元素数同阶，不随字段数翻倍', () => {
    const form = mountForm();
    const elements = form.querySelectorAll('*').length + 1;
    const opener = countingOpener();
    const adapter = compileBundledAdapter(generic as never);
    const options = { generic: true, openShadowRoot: opener.open } as never;
    const root = adapter.resolveRoot(document, options);
    expect(root).not.toBeNull();
    const fields = [...adapter.scan(root!, options)];
    expect(fields).toHaveLength(FIELDS);
    // 找表那一次扫描 + 这一次扫描，各建一份索引。从前是字段数 × 元素数 × 每字段几次查询（上万次）。
    expect(opener.calls()).toBeLessThanOrEqual(2 * elements);
  });
});

describe('拍子里与拍子外查到的是同一组元素、同一个顺序', () => {
  it('嵌套的开放影子根里的控件', () => {
    document.body.innerHTML = `
      <form id="application">
        <label for="a">Email</label><input id="a" type="email">
        <x-outer id="outer"></x-outer>
        <label for="z">Phone</label><input id="z" type="tel">
      </form>`;
    const outer = document.getElementById('outer')!;
    const outerShadow = outer.attachShadow({ mode: 'open' });
    outerShadow.innerHTML = `<input id="b" type="text"><x-inner id="inner"></x-inner><input id="c" type="text">`;
    const inner = outerShadow.getElementById('inner')!;
    inner.attachShadow({ mode: 'open' }).innerHTML = `<textarea id="d"></textarea><select id="e"></select>`;

    const root = createScanRoot(document.querySelector('form')!, []);
    const outside = root.querySelectorAll(CONTROL_SELECTOR).map((element) => element.id);
    const inside = withScanPass(root, () => root.querySelectorAll(CONTROL_SELECTOR).map((element) => element.id));
    expect(inside).toEqual(outside);
    expect(outside).toEqual(['a', 'z', 'b', 'c', 'd', 'e']);
  });
});

describe('拍子一结束就不再用旧索引', () => {
  it('拍子之后挂上的影子根，下一次查询看得见', () => {
    document.body.innerHTML = `<form id="application"><div id="host"></div><input id="a" type="text"></form>`;
    const root = createScanRoot(document.querySelector('form')!, []);
    expect(withScanPass(root, () => root.querySelectorAll('input').map((element) => element.id))).toEqual(['a']);
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<input id="late" type="text">';
    expect(root.querySelectorAll('input').map((element) => element.id)).toEqual(['a', 'late']);
    expect(withScanPass(root, () => root.querySelectorAll('input').map((element) => element.id))).toEqual(['a', 'late']);
  });
});
