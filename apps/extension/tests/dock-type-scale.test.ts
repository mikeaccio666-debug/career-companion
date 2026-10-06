// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow } from '../lib/autofillDock';
import { AI_FIELD_CSS } from '../lib/dock/aiField';
import { DOCK_CSS } from '../lib/dock/css';

/**
 * 浮层的字号只有四档（2026-09-24 负责人：大字都一个字号，全片字号种类不要太多）。
 *
 * 钉住三件事：四个变量只在 `.root` 上定义一次、值就是那四档；浮层的每一张样式表、每一处内联样式写字号时
 * 只用这四个变量（字号与行高成对）；每一幕里 20px 的字最多一处。
 */
const DOCK_DIR = resolve(__dirname, '../lib/dock');
const TOKENS = ['title', 'body', 'meta', 'caption'] as const;
const SCALE: Record<(typeof TOKENS)[number], readonly [size: string, lineHeight: string]> = {
  title: ['20px', '28px'],
  body: ['15px', '22px'],
  meta: ['13px', '18px'],
  caption: ['11px', '14px'],
};

/** 浮层每一个源文件里写着的字号：样式表里的、内联 cssText 里的，一个不漏。 */
const sources = (): ReadonlyArray<readonly [file: string, text: string]> =>
  readdirSync(DOCK_DIR).filter((name) => name.endsWith('.ts')).map((name) => [name, readFileSync(resolve(DOCK_DIR, name), 'utf8')] as const);

describe('浮层字号：四档', () => {
  it('四个变量只在 .root 上定义一次：20/28、15/22、13/18、11/14', () => {
    for (const token of TOKENS) {
      const [size, lineHeight] = SCALE[token];
      const sizes = [...DOCK_CSS.matchAll(new RegExp(`--fs-${token}:([^;}]+)`, 'g'))].map((match) => match[1]);
      const heights = [...DOCK_CSS.matchAll(new RegExp(`--lh-${token}:([^;}]+)`, 'g'))].map((match) => match[1]);
      expect(sizes, token).toEqual([size]);
      expect(heights, token).toEqual([lineHeight]);
    }
    const defined = new Set([...DOCK_CSS.matchAll(/--fs-([a-z]+):/g)].map((match) => match[1]));
    expect([...defined].sort(), '没有第五个字号变量').toEqual([...TOKENS].sort());
  });

  it('每一处字号都是这四个变量之一，行高同一档成对写', () => {
    const offenders: string[] = [];
    for (const [file, text] of sources()) {
      for (const match of text.matchAll(/font-size\s*:\s*([^;}'"`\n]+)/g)) {
        const value = (match[1] ?? '').trim();
        const token = /^var\(--fs-(title|body|meta|caption)\)$/.exec(value)?.[1];
        if (token === undefined) { offenders.push(`${file}: font-size:${value}`); continue; }
        // 同一条声明里紧跟着的行高必须是同一档（字号 15、行高 18 的那种拼凑不许出现）。
        const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 120);
        const lineHeight = /line-height\s*:\s*([^;}'"`\n]+)/.exec(after.split('}')[0] ?? '')?.[1]?.trim();
        if (lineHeight !== undefined && lineHeight !== `var(--lh-${token})`) offenders.push(`${file}: font-size ${token} 配 line-height:${lineHeight}`);
      }
      for (const match of text.matchAll(/(?<![-\w])font\s*:\s*([^;}'"`\n]+)/g)) {
        if ((match[1] ?? '').trim() !== 'inherit') offenders.push(`${file}: font:${match[1]}`);
      }
      if (/\.fontSize\s*=|setProperty\(\s*['"]font-size/.test(text)) offenders.push(`${file}: 脚本里直接改字号`);
    }
    expect(offenders).toEqual([]);
  });

  it('AI 标记与卡片的样式表也只用这四档', () => {
    const sizes = [...AI_FIELD_CSS.matchAll(/font-size:([^;}]+)/g)].map((match) => match[1]);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toMatch(/^var\(--fs-(title|body|meta|caption)\)$/);
  });
});

/** 用 --fs-title 的那几个选择器（从样式表里读，不手抄）。 */
const titleSelectors = (): string[] => {
  const out: string[] = [];
  for (const match of DOCK_CSS.matchAll(/(?:^|\n|\})([^{}\n]+)\{([^{}]*)\}/g)) {
    if ((match[2] ?? '').includes('font-size:var(--fs-title)')) out.push((match[1] ?? '').trim());
  }
  return out;
};

/**
 * 样式表里只写着 `display:none` 的那几条规则（比如岗位卡收成一行时藏起大标题）：测试环境不算样式表，
 * 这里照着规则本身把命中的节点记成看不见。
 */
const hiddenByStylesheet = (root: ParentNode): Set<Element> => {
  const out = new Set<Element>();
  for (const match of DOCK_CSS.matchAll(/(?:^|\n|\})([^{}\n]+)\{display:none\}/g)) {
    for (const node of Array.from(root.querySelectorAll((match[1] ?? '').trim()))) out.add(node);
  }
  return out;
};

/** 用户此刻看得见的：自己与祖先都没有 display:none、inert、关着的折叠或菜单。 */
const visible = (node: Element, hidden: ReadonlySet<Element>): boolean => {
  for (let at: Element | null = node; at !== null; at = at.parentElement) {
    const style = (at as HTMLElement).style;
    if (hidden.has(at) || style?.display === 'none' || style?.visibility === 'hidden' || at.hasAttribute('inert')) return false;
    if ((at.classList.contains('fold') || at.classList.contains('fold-rest') || at.classList.contains('pop')) && (at as HTMLElement).dataset.open !== 'true') return false;
  }
  return true;
};

const titlesOnScreen = (root: ParentNode | null | undefined): string[] => {
  if (root == null) return [];
  const hidden = hiddenByStylesheet(root);
  return Array.from(root.querySelectorAll<HTMLElement>(titleSelectors().join(',')))
    .filter((node) => visible(node, hidden))
    .map((node) => node.textContent ?? '');
};

const ROWS: readonly AutofillDockFieldRow[] = [
  { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex' },
  { label: 'Why us?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY' },
];

const mount = (extra: Record<string, unknown> = {}, face: Parameters<typeof mountAutofillDock>[0] = { kind: 'UNAVAILABLE', reason: 'NO_MISSION' }) => {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock(face, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    vendorLabel: 'Ashby',
    jobCard: () => ({ title: 'Mobile Engineer, Android', company: 'Ramp' }),
    ...extra,
  }, doc);
  handle.openPanel();
  return handle;
};

describe('每一幕里 20px 的字最多一处', () => {
  it('样式表里用 --fs-title 的只有总结、脸与失败卡的那一句、首页展开的岗位名、资料页的页名', () => {
    expect(titleSelectors().sort()).toEqual(['.face-title', '.head-title', '.job-title-lg', '.sum-title']);
  });

  it('首页展开的岗位卡：岗位名是这一幕唯一的 20px；一开始填它就收成 15px 的一行', () => {
    const handle = mount({ jobCard: () => ({ title: 'Mobile Engineer, Android', company: 'Ramp', facts: { workMode: 'REMOTE', employment: 'FULL_TIME' } }) });
    expect(titlesOnScreen(handle.sceneRoot())).toEqual(['Mobile Engineer, Android']);
    handle.beginPreparing();
    expect(titlesOnScreen(handle.sceneRoot())).toEqual([]);
  });

  it('填完那一幕：只有总结那一句是 20px，岗位名与行的题目不是', () => {
    const handle = mount();
    handle.beginPreparing();
    handle.beginRun({ runId: 'r1', requiredQuestions: 2, requiredCompleted: 1, rows: ROWS, phase: 'SETTLED' } as never);
    expect(titlesOnScreen(handle.sceneRoot())).toEqual(['还有 1 项需要你']);
  });

  it('首页、失败卡、没连接那张脸、资料页：各自至多一处', () => {
    expect(titlesOnScreen(mount().sceneRoot()).length).toBeLessThanOrEqual(1);
    const failed = mount();
    failed.beginPreparing();
    failed.reportBlocked('NO_FORM_FOUND');
    expect(titlesOnScreen(failed.sceneRoot())).toEqual(['这一轮没有完成']);
    expect(titlesOnScreen(mount({}, { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }).sceneRoot())).toEqual(['连接 ArgoLand，一键填好申请表']);
    const profile = mount();
    profile.openProfile();
    expect(titlesOnScreen(profile.sceneRoot())).toEqual(['我的资料']);
  });
});
