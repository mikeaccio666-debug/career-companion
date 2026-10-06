// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';
import {
  COLLAPSE_MEMORY_MS,
  collapsedRecently,
  createDockAutoOpen,
  freshCollapses,
  isFillableFace,
  withCollapse,
  withoutCollapse,
} from '../lib/dockAutoOpen';
import type { AutofillAffordance } from '../product-panel/affordance';

/**
 * 能填的申请表上自动打开浮层（2026-09-24 负责人：Jobright 就是这样），但尊重用户：一次加载只开一次；这一页收起过
 * 就不再开；这个站点 30 分钟之内收起过就保持收起；填不了的几张脸永远不自动开。
 */
const FILLABLE: readonly AutofillAffordance[] = [{ kind: 'READY' }, { kind: 'UNAVAILABLE', reason: 'NO_MISSION' }];
const NOT_FILLABLE: readonly AutofillAffordance[] = [
  { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' },
  { kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' },
  { kind: 'DORMANT' },
  { kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' },
  { kind: 'GUIDANCE', guidance: 'NO_FORM_FOUND' },
  { kind: 'HIDDEN' },
];
const ORIGIN = 'https://jobs.ashbyhq.com';
const NOW = Date.UTC(2026, 8, 24, 16, 0);

describe('什么时候自动打开', () => {
  it('能填的那一面：一次页面加载只开一次', () => {
    for (const face of FILLABLE) {
      const policy = createDockAutoOpen();
      expect(policy.shouldOpen(face, false), JSON.stringify(face)).toBe(true);
      policy.opened();
      expect(policy.shouldOpen(face, false), `${JSON.stringify(face)}：同一次加载里换脸重挂不再开`).toBe(false);
    }
  });

  it('用户在这一页收起过：这一次加载里不再开（多页申请在同一个标签页里翻到下一页也一样）', () => {
    const policy = createDockAutoOpen();
    policy.collapsed();
    expect(policy.shouldOpen({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, false)).toBe(false);
  });

  it('这个站点 30 分钟之内收起过：保持收起', () => {
    expect(createDockAutoOpen().shouldOpen({ kind: 'READY' }, true)).toBe(false);
  });

  it('填不了的几张脸（没连接、取不到规则、不是申请表、要先登录、没找到表）：永远不自动开', () => {
    for (const face of NOT_FILLABLE) {
      expect(isFillableFace(face), JSON.stringify(face)).toBe(false);
      expect(createDockAutoOpen().shouldOpen(face, false), JSON.stringify(face)).toBe(false);
    }
  });
});

/**
 * 公司自己做的申请表（通用路——主机不在厂商表里、也没有厂商指纹）：表里有只有求职才问的栏（简历／CV 上传、LinkedIn、
 * 工作授权、学历）才像厂商申请页一样自动打开（负责人 2026-09-28，取代 2026-09-25「先严格」那一版的一律不开）；
 * 只靠 JobPosting 或招聘页网址撑着的表照旧只挂收着的标签，用户点开才填。厂商的申请页与白标照旧。
 */
describe('公司自己做的表（通用路）：有只有求职才问的栏才自动打开', () => {
  it('没有那几栏：能填的脸也不开', () => {
    for (const face of FILLABLE) {
      expect(createDockAutoOpen().shouldOpen(face, false, { lane: 'company', jobOnlyFields: false }), JSON.stringify(face)).toBe(false);
    }
  });

  it('有那几栏：能填的脸自动打开', () => {
    for (const face of FILLABLE) {
      expect(createDockAutoOpen().shouldOpen(face, false, { lane: 'company', jobOnlyFields: true }), JSON.stringify(face)).toBe(true);
    }
  });

  it('厂商的申请页照旧自动打开（第三个参数缺省或是厂商）', () => {
    expect(createDockAutoOpen().shouldOpen({ kind: 'READY' }, false)).toBe(true);
    expect(createDockAutoOpen().shouldOpen({ kind: 'READY' }, false, { lane: 'vendor' })).toBe(true);
  });
});

describe('收起的记录（按 origin，30 分钟）', () => {
  it('收起之后 30 分钟之内算；过了就不算', () => {
    const stored = withCollapse({}, ORIGIN, NOW);
    expect(collapsedRecently(stored, ORIGIN, NOW + 1_000)).toBe(true);
    expect(collapsedRecently(stored, ORIGIN, NOW + COLLAPSE_MEMORY_MS - 1)).toBe(true);
    expect(collapsedRecently(stored, ORIGIN, NOW + COLLAPSE_MEMORY_MS)).toBe(false);
    expect(collapsedRecently(stored, 'https://boards.greenhouse.io', NOW + 1_000), '别的站点不受影响').toBe(false);
  });

  it('只按 origin 记一个时间；写的时候丢掉过期的；形状不对的当没有', () => {
    const old = { 'https://apply.workable.com': NOW - COLLAPSE_MEMORY_MS - 1, 'https://jobs.lever.co': NOW - 60_000 };
    expect(withCollapse(old, ORIGIN, NOW)).toEqual({ [ORIGIN]: NOW, 'https://jobs.lever.co': NOW - 60_000 });
    expect(freshCollapses({ 'not an origin': NOW, [ORIGIN]: 'yesterday', 'https://a.example/path': NOW }, NOW)).toEqual({});
    expect(freshCollapses(null, NOW)).toEqual({});
    expect(freshCollapses([ORIGIN], NOW)).toEqual({});
    expect(freshCollapses({ [ORIGIN]: NOW + 60_000 }, NOW), '将来的时间不认').toEqual({});
  });

  it('用户后来自己点开了：删掉这个站点的记录', () => {
    const stored = withCollapse({}, ORIGIN, NOW);
    expect(collapsedRecently(withoutCollapse(stored, ORIGIN, NOW + 1_000), ORIGIN, NOW + 2_000)).toBe(false);
  });
});

describe('浮层：用户自己收起、自己点开', () => {
  class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
  const mount = () => {
    const events: string[] = [];
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
      onAutofill: () => {},
      onOpenEntry: () => {},
      autoOpen: true,
      onCollapse: () => { events.push('collapse'); },
      onLauncherOpen: () => { events.push('launcher-open'); },
    }, doc);
    return { handle, events, doc };
  };

  it('自动打开：挂上就是开着的', () => {
    expect(mount().handle.isOpen()).toBe(true);
  });

  it('页头的「收起」与 Esc 算用户收起；程序收起（closePanel）不算', () => {
    const { handle, events } = mount();
    handle.closePanel();
    expect(events).toEqual([]);
    handle.launcherButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(events, '点收起按钮打开：用户自己点开的').toEqual(['launcher-open']);
    handle.sceneRoot()?.querySelector('.collapse')?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(events).toEqual(['launcher-open', 'collapse']);
    expect(handle.isOpen()).toBe(false);
  });

  it('Esc 收起也算', () => {
    class TrustedKey extends KeyboardEvent { get isTrusted() { return true; } }
    const events: string[] = [];
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
      onAutofill: () => {}, onOpenEntry: () => {}, autoOpen: true, onCollapse: () => { events.push('collapse'); },
    }, document);
    try {
      handle.sceneRoot()!.dispatchEvent(new TrustedKey('keydown', { key: 'Escape', bubbles: true, composed: true }));
      expect(handle.isOpen()).toBe(false);
      expect(events).toEqual(['collapse']);
    } finally {
      handle.dismiss();
    }
  });
});

/**
 * 2026-10-03 前端体检 P0-2：自动打开（能填的表一挂上就开；规则晚到的重查；在公司自建的表上点一下之后 0.8、2.5 秒的复查；
 * 站内换页）从前把焦点移进面板——他正在网页上打字，下一个键就丢了（实测：在 First Name 打 Alex，x 没进任何地方）。
 * 自动打开从不挪焦点；只有他自己点开（点启动按钮，或在启动按钮上按回车、空格）才把焦点放进面板。
 */
describe('自动打开不抢焦点', () => {
  class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

  it('他正在网页上打字：浮层自己打开了，焦点还在那一格里', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, autoOpen: true }, document);
    try {
      expect(handle.isOpen()).toBe(true);
      expect(document.activeElement, '下一个键照旧打进那一格').toBe(input);
      expect(handle.hasFocus()).toBe(false);
    } finally {
      handle.dismiss();
      input.remove();
    }
  });

  it('他自己点开启动按钮：焦点进面板', () => {
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
    try {
      expect(handle.isOpen()).toBe(false);
      handle.launcherButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
      expect(handle.isOpen()).toBe(true);
      expect(document.activeElement).not.toBe(document.body);
      expect(handle.hasFocus()).toBe(true);
    } finally {
      handle.dismiss();
    }
  });

  it('开着时调用方再要一次打开（换语言重挂之后）：焦点放回面板', () => {
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {}, autoOpen: true }, document);
    try {
      expect(handle.hasFocus()).toBe(false);
      handle.openPanel();
      expect(handle.hasFocus()).toBe(true);
    } finally {
      handle.dismiss();
    }
  });
});
