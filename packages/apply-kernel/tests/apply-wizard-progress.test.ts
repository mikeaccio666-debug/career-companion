import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { detectHumanCheckpoint, readWizardProgress } from '../src/wizardAdvance';

/**
 * 连填（2026-09-28）要从页面上读的两件事，都是通用的读法、不认任何一家的 DOM：
 *
 *  · 网站自己说的「第几步、共几步、这一步叫什么」——浮层据此写「第 2 页，共 5 页：正在填「My Experience」」。
 *    只认两种公开的说法：ARIA 的 `aria-current="step"`，与读屏文字「current step 2 of 5」。说不出就不说。
 *  · 页面上是不是弹出了只能本人处理的关卡：登录（密码框）、验证码（one-time-code）、人机验证的挑战框。
 *    有就不再往下翻，照实告诉他要做什么。
 */

afterEach(() => { document.body.innerHTML = ''; });

/** 关卡那几条要摆验证码服务的 iframe：让 happy-dom 别去加载它们（测试不碰网络）。 */
const happyDom = (globalThis as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM;
const iframeLoading = happyDom?.settings.disableIframePageLoading;
beforeAll(() => { if (happyDom !== undefined) happyDom.settings.disableIframePageLoading = true; });
afterAll(() => { if (happyDom !== undefined && iframeLoading !== undefined) happyDom.settings.disableIframePageLoading = iframeLoading; });

const visible = () => true;
const read = (html: string, isVisible: (element: Element) => boolean = visible) => {
  document.body.innerHTML = html;
  return readWizardProgress({ document, isVisible });
};
/** `hiddenId`：这个 id 的元素量成看不见。 */
const checkpoint = (html: string, hiddenId?: string) => {
  document.body.innerHTML = html;
  const hidden = hiddenId === undefined ? null : document.getElementById(hiddenId);
  return detectHumanCheckpoint({ document, isVisible: (element) => element !== hidden });
};

describe('网站说的第几步、共几步、这一步叫什么', () => {
  it('Workday 的进度条读屏文字「current step 5 of 7 Voluntary Disclosures」（2026-09 夹具的样子）', () => {
    expect(read('<div data-automation-id="progressBarActiveStep">current step 5 of 7 Voluntary Disclosures</div>'))
      .toEqual({ index: 5, total: 7, name: 'Voluntary Disclosures' });
  });

  it('读屏文字与步骤名分在两个节点里 → 名字取同一格里的其余文字', () => {
    expect(read(`
      <ol>
        <li><label>completed step 1 of 5</label><div>My Information</div></li>
        <li><label>current step 2 of 5</label><div>My Experience</div></li>
        <li><label>step 3 of 5</label><div>Application Questions</div></li>
      </ol>`)).toEqual({ index: 2, total: 5, name: 'My Experience' });
  });

  it('ARIA：唯一一个 aria-current="step" → 名字是它的字，第几步、共几步按它在列表里的位置', () => {
    expect(read(`
      <ol>
        <li>Contact</li>
        <li aria-current="step">Experience</li>
        <li>Questions</li>
        <li>Review</li>
      </ol>`)).toEqual({ index: 2, total: 4, name: 'Experience' });
  });

  it('aria-current 的那一格自己写着「Step 3 of 6: Questions」→ 照它说的', () => {
    expect(read('<nav><span aria-current="step">Step 3 of 6: Questions</span></nav>'))
      .toEqual({ index: 3, total: 6, name: 'Questions' });
  });

  it('不在列表里、也没写第几步 → 只有名字', () => {
    expect(read('<nav><span aria-current="step">Voluntary Disclosures</span></nav>'))
      .toEqual({ index: null, total: null, name: 'Voluntary Disclosures' });
  });

  it.each([
    ['什么都没有', '<form><label>First Name<input></label></form>'],
    ['两个 current step（说不清是哪一步）', '<p>current step 1 of 3</p><p>current step 2 of 3</p>'],
    ['两个 aria-current="step"', '<span aria-current="step">A</span><span aria-current="step">B</span>'],
    ['第几步比共几步还大（读错了）', '<p>current step 7 of 5 Review</p>'],
    ['aria-current="page" 是导航，不是步骤', '<nav><a aria-current="page" href="/jobs">Jobs</a></nav>'],
  ])('%s → 不说', (_name, html) => {
    expect(read(html)).toBeNull();
  });

  it('看不见的那一个不算', () => {
    document.body.innerHTML = '<span id="a" aria-current="step">Hidden</span>';
    const hidden = document.getElementById('a')!;
    expect(readWizardProgress({ document, isVisible: (element) => element !== hidden })).toBeNull();
  });

  it('名字太长（整段说明文字）→ 不当步骤名，第几步照说', () => {
    const long = 'x'.repeat(120);
    expect(read(`<div>current step 2 of 4 ${long}</div>`)).toEqual({ index: 2, total: 4, name: null });
  });

  it('脚本里的字不算', () => {
    expect(read('<script>var s = "current step 2 of 5 Secret";</script>')).toBeNull();
  });
});

describe('只能本人处理的关卡', () => {
  it('看得见的密码框 → 登录', () => {
    expect(checkpoint('<label>Password<input type="password"></label>')).toBe('LOGIN');
    expect(checkpoint('<input type="text" autocomplete="new-password">')).toBe('LOGIN');
  });

  it('看得见的一次性验证码框 → 验证码', () => {
    expect(checkpoint('<label>Code<input autocomplete="one-time-code"></label>')).toBe('VERIFICATION');
  });

  it('reCAPTCHA / hCaptcha 的挑战弹层 → 人机验证', () => {
    expect(checkpoint('<iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc"></iframe>')).toBe('CAPTCHA');
    expect(checkpoint('<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=0"></iframe>')).toBe('CAPTCHA');
  });

  it('Cloudflare 那种整页挑战的容器 → 人机验证', () => {
    expect(checkpoint('<div id="challenge-running">Checking your browser…</div>')).toBe('CAPTCHA');
  });

  it.each([
    ['看不见的密码框（登录弹层收着）', '<input id="x" type="password">'],
    ['看不见的挑战弹层（reCAPTCHA 没触发时就挂在页面上）', '<iframe id="x" src="https://www.google.com/recaptcha/api2/bframe?k=abc"></iframe>'],
  ])('%s → 不算', (_name, html) => {
    expect(checkpoint(html, 'x')).toBeNull();
  });

  it.each([
    ['隐形 reCAPTCHA 的角标（anchor，不是挑战）', '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc&size=invisible"></iframe>'],
    ['hCaptcha 的勾选框（不是挑战弹层）', '<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0"></iframe>'],
    ['普通申请表', '<form><label>Email<input type="email"></label><button type="button">Next</button></form>'],
    ['属性里藏着 hidden 的密码框', '<div hidden><input type="password"></div>'],
  ])('%s → 不算关卡', (_name, html) => {
    expect(checkpoint(html)).toBeNull();
  });

  describe('账号墙那一路（2026-09-28，ignoreLogin：密码框就是那一页本身）', () => {
    const onWall = (html: string) => {
      document.body.innerHTML = html;
      return detectHumanCheckpoint({ document, isVisible: visible, ignoreLogin: true });
    };

    it('只有密码框 → 不算关卡（不给 ignoreLogin 照旧是「要他登录」）', () => {
      const html = '<label>Email<input type="email"></label><label>Password<input type="password"></label>';
      expect(checkpoint(html)).toBe('LOGIN');
      expect(onWall(html)).toBeNull();
    });

    it('密码框旁边弹出了人机验证的挑战框 → 人机验证（不再被「登录」盖住）', () => {
      expect(onWall('<input type="password"><iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc"></iframe>')).toBe('CAPTCHA');
    });

    it('密码框旁边要一次性验证码 → 验证码', () => {
      expect(onWall('<input type="password"><input autocomplete="one-time-code">')).toBe('VERIFICATION');
    });
  });
});
