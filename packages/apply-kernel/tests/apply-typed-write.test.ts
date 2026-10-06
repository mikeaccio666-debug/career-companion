import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consumeAuthority, releaseAuthority, type HostWriteAuthority } from '../src/grant';
import { createUndoJournal } from '../src/undo';
import {
  MAX_TYPED_CHARS_PER_AUTHORITY,
  MAX_TYPED_CHARS_PER_FIELD,
  typeTextValue,
} from '../src/write/typeValue';
import { testAuthority } from './helpers/applyTestAuthority';

/**
 * 逐字符写入原语（CAP-AF-002 / CAP-AF-003 的硬前置）。
 *
 * 病根见 50-证据库 §F.6-s：Workable 经历行的控件只接受逐字符增量输入，
 * 整串写入被宿主表单状态拒收而 `element.value` 留着 ⇒ 回读判决把失败报成成功。
 *
 * 本文件锁三样东西：
 *  1. **它真的逐字符发** `InputEvent{inputType:'insertText'}`，不是一次赋值；
 *  2. **承重不变量 T1**：`ok:false` ⟺ 一次宿主 mutation 都没发生；
 *  3. **三条硬约束**：不发键盘事件、不夺焦点、不碰 selection。
 */

let authority: HostWriteAuthority;

beforeEach(() => {
  authority = testAuthority(null, 'fill', ['set-text']);
  expect(consumeAuthority(authority).ok, '测试前置：授权没进入运行态').toBe(true);
});

afterEach(() => {
  releaseAuthority(authority);
  document.body.innerHTML = '';
});

function field(value = ''): HTMLInputElement {
  document.body.innerHTML = '<input id="t" type="text" />';
  const el = document.querySelector<HTMLInputElement>('#t')!;
  el.value = value;
  return el;
}

function ticket(el: HTMLInputElement | HTMLTextAreaElement) {
  const recorded = createUndoJournal().record(el);
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error('unreachable');
  return recorded.value;
}

/** 捕获期监听，锁的是宿主**观测得到**的行为，不是我们内部调了哪个 API。 */
function watch(types: readonly string[]) {
  const seen: Array<{ type: string; inputType?: string; data?: string | null; isTrusted: boolean }> = [];
  const record = (e: Event) => seen.push({
    type: e.type,
    inputType: (e as InputEvent).inputType,
    data: (e as InputEvent).data,
    isTrusted: e.isTrusted === true,
  });
  for (const t of types) document.addEventListener(t, record, true);
  return { seen, stop: () => { for (const t of types) document.removeEventListener(t, record, true); } };
}

const ALL_WATCHED = [
  'input', 'change', 'blur', 'focusout', 'focus', 'focusin',
  'keydown', 'keyup', 'keypress', 'beforeinput', 'compositionstart', 'compositionend',
];

describe('逐字符写入', () => {
  it('每个字符一个 insertText，顺序与内容都对', () => {
    const el = field();
    const w = watch(ALL_WATCHED);
    try {
      expect(typeTextValue({ element: el, keystrokes: 'Acme', authority, ticket: ticket(el) })).toEqual({
        ok: true, value: 'Acme',
      });
    } finally { w.stop(); }

    const inserts = w.seen.filter((e) => e.type === 'input' && e.inputType === 'insertText');
    expect(inserts.map((e) => e.data)).toEqual(['A', 'c', 'm', 'e']);
    expect(el.value).toBe('Acme');
  });

  it('收尾恰好一轮 change / blur / focusout，不多补一个裸 input', () => {
    const el = field();
    const w = watch(ALL_WATCHED);
    try { typeTextValue({ element: el, keystrokes: 'ab', authority, ticket: ticket(el) }); }
    finally { w.stop(); }
    expect(w.seen.filter((e) => e.type === 'change')).toHaveLength(1);
    expect(w.seen.filter((e) => e.type === 'blur')).toHaveLength(1);
    expect(w.seen.filter((e) => e.type === 'focusout')).toHaveLength(1);
    // N 个 insertText 之后再补一个裸 input 是白送宿主一次副作用。
    expect(w.seen.filter((e) => e.type === 'input' && e.inputType === undefined)).toEqual([]);
  });

  it('清空是逐次退格，不是一次赋空串', () => {
    // 整串赋值正是被宿主表单状态拒收的那条路，清空同理；
    // 而且掩码框对「一次清空」与「逐次退格」的状态机反应不同。
    const el = field('old');
    const w = watch(['input']);
    try { typeTextValue({ element: el, keystrokes: 'X', authority, ticket: ticket(el) }); }
    finally { w.stop(); }
    const deletes = w.seen.filter((e) => e.inputType === 'deleteContentBackward');
    expect(deletes).toHaveLength(3);
    // ⚠️ 环境差异：happy-dom 把 `data: null` 归一成 `''`（实测），真实浏览器保留 `null`。
    // 所以这条只能断言「不带内容」，**证明不了我们传的是 null**——那一点由
    // `HostInputIntent` 的类型（`data: string | null`）与 `typeValue.ts` 里
    // deleteContentBackward 恒传 null 保证。与 `isTrusted` 在 happy-dom 里恒为
    // undefined 是同一类问题：写成 `toBe(null)` 会假红，写成 `toBe('')` 会在
    // 真实浏览器上假红。
    expect(deletes.every((e) => !e.data), '删除事件不该带内容').toBe(true);
    expect(el.value).toBe('X');
  });
});

describe('三条硬约束', () => {
  it('绝不发键盘 / beforeinput / composition 事件', () => {
    const el = field();
    const w = watch(ALL_WATCHED);
    try { typeTextValue({ element: el, keystrokes: 'ab', authority, ticket: ticket(el) }); }
    finally { w.stop(); }
    const forbidden = [...new Set(w.seen.map((e) => e.type))].filter(
      (t) => !['input', 'change', 'blur', 'focusout'].includes(t),
    );
    expect(forbidden, `派发了白名单外的事件：${forbidden.join(', ')}`).toEqual([]);
  });

  it('绝不夺焦点', () => {
    // 真实焦点转移会让浏览器对**上一栏**派一个 isTrusted 的 change，
    // 落进上一栏仍然挂着的编辑闩锁。
    document.body.innerHTML = '<input id="other" /><input id="t" type="text" />';
    const other = document.querySelector<HTMLInputElement>('#other')!;
    const el = document.querySelector<HTMLInputElement>('#t')!;
    other.focus();
    typeTextValue({ element: el, keystrokes: 'ab', authority, ticket: ticket(el) });
    expect(document.activeElement).toBe(other);
  });

  it('派出去的事件一律不是可信事件', () => {
    // isTrusted 变真 ⇒ watchTrustedUserEdits 把我们打的每个字符判成用户编辑
    // ⇒ 静默 abandon 却仍报成功。happy-dom 里合成事件的 isTrusted 是 undefined，
    // 所以断言写 toBe(false) 会假红——用 toBeFalsy。
    const el = field();
    const w = watch(['input', 'change']);
    try { typeTextValue({ element: el, keystrokes: 'ab', authority, ticket: ticket(el) }); }
    finally { w.stop(); }
    expect(w.seen.length).toBeGreaterThan(0);
    expect(w.seen.every((e) => !e.isTrusted)).toBe(true);
  });
});

describe('承重不变量 T1：ok:false ⟺ 一次宿主 mutation 都没发生', () => {
  it('能力位不对：值不动、事件一个不发', () => {
    const el = field('untouched');
    const other = testAuthority(null, 'fill', ['set-select']);
    expect(consumeAuthority(other).ok).toBe(true);
    const w = watch(ALL_WATCHED);
    try {
      expect(typeTextValue({ element: el, keystrokes: 'X', authority: other, ticket: ticket(el) })).toEqual({
        ok: false, code: 'CAPABILITY_DISABLED',
      });
    } finally { w.stop(); releaseAuthority(other); }
    expect(el.value).toBe('untouched');
    expect(w.seen).toEqual([]);
  });

  it('超单栏上限：宁可不写，绝不写半截', () => {
    const el = field('untouched');
    const w = watch(ALL_WATCHED);
    try {
      expect(typeTextValue({
        element: el, keystrokes: 'x'.repeat(MAX_TYPED_CHARS_PER_FIELD + 1), authority, ticket: ticket(el),
      })).toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
    } finally { w.stop(); }
    expect(el.value, '写了半截').toBe('untouched');
    expect(w.seen).toEqual([]);
  });

  it('授权字符刹车耗尽：同样零 mutation', () => {
    const el = field();
    const chunk = 'x'.repeat(MAX_TYPED_CHARS_PER_FIELD);
    let calls = 0;
    while (calls * MAX_TYPED_CHARS_PER_FIELD < MAX_TYPED_CHARS_PER_AUTHORITY) {
      const target = field();
      expect(typeTextValue({ element: target, keystrokes: chunk, authority, ticket: ticket(target) }).ok).toBe(true);
      calls += 1;
    }
    const last = field('untouched');
    const w = watch(ALL_WATCHED);
    try {
      expect(typeTextValue({ element: last, keystrokes: 'x', authority, ticket: ticket(last) })).toEqual({
        ok: false, code: 'ABORTED',
      });
    } finally { w.stop(); }
    expect(last.value).toBe('untouched');
    expect(w.seen).toEqual([]);
    void el;
  });
});

describe('宿主改写我们打的字：不是失败', () => {
  it('宿主把值顶回去：返回 ok 带实际值，交给回读判决', () => {
    // 做成失败会让 runner abandon 掉一张其实已经动过宿主的票，用户就撤不回来了。
    const el = field();
    // 模拟掩码：每次 input 之后把值改写成大写 + 加前缀
    el.addEventListener('input', () => {
      const raw = el.value;
      if (!raw.startsWith('#')) el.value = `#${raw.toUpperCase()}`;
    });
    const result = typeTextValue({ element: el, keystrokes: 'ab', authority, ticket: ticket(el) });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(el.value);
    expect(result.ok && result.value).not.toBe('ab');
  });

  it('宿主拒绝删除：第一下就停手，不把整串退格全敲一遍', () => {
    // 上界计数器本身就能终止循环，所以「停手」不能只靠「没死循环」证明——
    // 它是可观测的：停手 ⇒ 只发 1 个删除事件；不停手 ⇒ 值有多长就发多少个，
    // 每一个都被宿主顶回去，白白多打扰宿主 5 次。
    const el = field('locked');
    el.addEventListener('input', () => { el.value = 'locked'; });
    const w = watch(['input']);
    let result;
    try {
      result = typeTextValue({ element: el, keystrokes: 'X', authority, ticket: ticket(el) });
    } finally { w.stop(); }
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('locked');
    expect(
      w.seen.filter((e) => e.inputType === 'deleteContentBackward'),
      '宿主已经明说不接受删除，还继续敲',
    ).toHaveLength(1);
  });
});

/**
 * runner 真的走了逐字符通路（接线证明）。
 *
 * ⚠️ 本节存在的理由：`runner.ts` 里那句 `if (entry.writeMode === 'typed')`
 * 一度**没有任何测试**——把它改成 `if (false)` 全仓 1264 条照样全绿。
 * 那正是这个仓被咬过五次的形态（蜜罐守卫、推荐人守卫、JOB_DEPENDENT、
 * stopNamePrefix、dateFormat）：登记齐全、就是没有调用方或没有证明。
 *
 * 锁的是**宿主观测得到的行为**：typed 条目必须看到逐字符的 insertText，
 * 缺省条目必须只看到一次裸 input。
 */
describe('接线：runner 按 writeMode 选通路', () => {
  async function runOne(writeMode: 'setValue' | 'typed' | undefined) {
    const { runApplyPlan } = await import('../src/runner');
    const { createUndoJournal } = await import('../src/undo');
    const { testApplyPolicy } = await import('./helpers/applyTestAuthority');
    const { createScanRoot } = await import('../src/scanRoot');
    const { fieldSignature } = await import('../src/fieldIdentity');

    document.body.innerHTML = '<form id="f"><input name="company" type="text" /></form>';
    const element = document.querySelector<HTMLInputElement>('input')!;
    const root = createScanRoot(document.querySelector('#f')!, [], []);
    const auth = testAuthority('fp', 'fill', ['set-text']);
    const seen: Array<{ type: string; inputType?: string }> = [];
    const record = (e: Event) => seen.push({ type: e.type, inputType: (e as InputEvent).inputType });
    document.addEventListener('input', record, true);
    let summary;
    try {
      summary = await runApplyPlan({
        plan: {
          vendor: 'workable',
          fingerprint: 'fp',
          entries: [{
            kind: 'text', element, key: 'experience.company', label: 'Company',
            value: 'Acme', order: 0, required: false, confidence: 1,
            // 真实签名：手搓的对不上，身份复核会直接 IDENTITY_CHANGED
            // ——那样这条测试就只是在测复核，不是在测接线。
            signature: fieldSignature(element, root),
            ...(writeMode === undefined ? {} : { writeMode }),
          }],
          skipped: [],
          fillEmptyOnly: true,
        },
        auth,
        journal: createUndoJournal(),
        root,
        policy: testApplyPolicy(),
      });
    } finally { document.removeEventListener('input', record, true); }
    return { seen, element, summary };
  }

  it('typed 条目：看到逐字符的 insertText', async () => {
    const { seen, element, summary } = await runOne('typed');
    expect(summary.abortedBy, `整轮被中止：${JSON.stringify(summary.results)}`).toBeNull();
    const inserts = seen.filter((e) => e.inputType === 'insertText');
    expect(inserts, 'runner 没走逐字符通路 —— typed 控件会被整串写入').toHaveLength(4);
    expect(element.value).toBe('Acme');
  });

  it('缺省条目：仍然是一次整串写入，行为一字不变', async () => {
    const { seen, element } = await runOne(undefined);
    expect(seen.filter((e) => e.inputType === 'insertText')).toEqual([]);
    expect(seen.filter((e) => e.type === 'input' && e.inputType === undefined).length).toBeGreaterThan(0);
    expect(element.value).toBe('Acme');
  });
});
