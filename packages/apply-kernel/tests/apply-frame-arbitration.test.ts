import { afterEach, describe, expect, it } from 'vitest';

import { shouldYieldToEmbeddedFrame } from '../src/gate/frameArbitration';

/**
 * 顶层文档与内嵌 iframe 的仲裁。
 *
 * A2b 之前，顶层文档根本不匹配注入范围，所以这个问题不存在——
 * `tests/e2e/apply-overlay-frame.spec.ts` 锁的就是"只有 iframe 挂浮层"。
 * 扩到全网之后顶层也会被注入，于是一个**既嵌了 ATS iframe、自己又有一张表单**的
 * 公司招聘页（最常见的形状是"人才库登记"：姓名 + 邮箱 + 简历上传）会让屏幕上
 * 同时出现两个浮层——两个都是 `position: fixed`，直接叠在一起。
 *
 * **刻意不用跨 frame 消息**：给页面 postMessage 会多一条页面可观测的通道，
 * 正是铁律 2/3 要避免的形状。改用同帧同步判断——顶层文档如果看得见一个指向
 * 已知 ATS 主机的 iframe，就让位给它。这不需要读那个 iframe 的内容，
 * 只读它自己 DOM 上的 `src` 属性。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

describe('顶层/iframe 仲裁', () => {
  it('顶层看见 ATS iframe 时让位', () => {
    document.body.innerHTML = `
      <h1>Careers at Acme</h1>
      <form id="talent-network"><input name="email" /></form>
      <iframe src="https://job-boards.greenhouse.io/acme/jobs/123"></iframe>`;
    expect(
      shouldYieldToEmbeddedFrame({ doc: document, isTopFrame: true }),
      '顶层没让位 —— 屏幕上会出现两个浮层',
    ).toBe(true);
  });

  it.each([
    'https://boards.greenhouse.io/embed/job_board?for=acme',
    'https://jobs.lever.co/acme/abc/apply',
    'https://jobs.ashbyhq.com/acme/xyz',
    'https://apply.workable.com/acme/j/ABC/apply',
  ])('识别各家的内嵌 src：%s', (src) => {
    document.body.innerHTML = `<iframe src="${src}"></iframe>`;
    expect(shouldYieldToEmbeddedFrame({ doc: document, isTopFrame: true })).toBe(true);
  });

  /**
   * **iframe 自己永远不让位**。让位规则只对顶层生效——否则 ATS 页面里如果还有
   * 一层嵌套（Greenhouse embed 里再嵌东西），真正持有表单的那一帧会把自己让掉，
   * 结果谁都不挂。
   */
  it('iframe 自己不让位', () => {
    document.body.innerHTML = `<iframe src="https://jobs.lever.co/acme/abc/apply"></iframe>`;
    expect(
      shouldYieldToEmbeddedFrame({ doc: document, isTopFrame: false }),
      'iframe 让位了 —— 那样就没有任何一帧会挂浮层',
    ).toBe(false);
  });

  /** 反向探针：没有 ATS iframe 时顶层必须自己上，否则整个功能在直达页上失效。 */
  it('顶层没有 ATS iframe 时不让位', () => {
    document.body.innerHTML = `
      <form id="application-form"><input name="email" /></form>
      <iframe src="https://www.youtube.com/embed/xyz"></iframe>
      <iframe src="/local/widget.html"></iframe>`;
    expect(
      shouldYieldToEmbeddedFrame({ doc: document, isTopFrame: true }),
      '顶层误让位 —— 直达的申请页会没有浮层',
    ).toBe(false);
  });

  it('完全没有 iframe 时不让位', () => {
    document.body.innerHTML = `<form id="application-form"><input name="email" /></form>`;
    expect(shouldYieldToEmbeddedFrame({ doc: document, isTopFrame: true })).toBe(false);
  });

  it('畸形或空 src 不让位（不能因为一个坏属性就整页哑掉）', () => {
    document.body.innerHTML = `<iframe></iframe><iframe src=""></iframe><iframe src="::::"></iframe>`;
    expect(shouldYieldToEmbeddedFrame({ doc: document, isTopFrame: true })).toBe(false);
  });

  /**
   * 主机名必须按**标签边界**匹配。`jobs.lever.co.evil.com` 是攻击者可控的域名，
   * 让顶层因为它而让位，等于给了一个"关掉浮层"的开关。
   */
  it('冒充 ATS 主机的域名不触发让位', () => {
    document.body.innerHTML = `<iframe src="https://jobs.lever.co.evil.com/x"></iframe>`;
    expect(shouldYieldToEmbeddedFrame({ doc: document, isTopFrame: true })).toBe(false);
  });
});
