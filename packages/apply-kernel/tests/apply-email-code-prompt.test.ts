import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import workdayRules from '@edaix/apply-rules/workday.json';
import { installBundledApplyAdapters } from '../src/bundledAdapters';
import { classifyManualOnly } from '../src/dict/guards';
import { buildApplyPlan } from '../src/engine';
import { consumeAuthority, releaseAuthority } from '../src/grant';
import { readApplyForm } from '../src/registry';
import { createBundledApplyPolicy } from '../src/policy';
import { resolveEmailCodePrompt } from '../src/rules/emailVerification';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { normalizeEmailCode, writeEmailCode } from '../src/write/emailCode';
import { testAuthority } from './helpers/applyTestAuthority';

/**
 * 邮箱验证码第 1 步（2026-10-04 负责人：网站把验证码发到他的邮箱，他在我方浮层里输或粘贴，插件写进网站那一格）。
 *
 * 夹具照 job-boards.greenhouse.io 公开前端代码里的组件手写（fieldset#email-verification、8 格 security-input-N），只有结构。
 * 这里锁三件事：规则认得出网站在要验证码、交出的就是那 8 格；说不清的时候一律认不出；写进去的只有他输的那一串，
 * 整理不对就一格都不碰，写完不提交。
 */

installBundledApplyAdapters();

const fixture = (path: string): string => readFileSync(resolve(__dirname, 'fixtures', path), 'utf8');
const greenhouse = compileBundledAdapter(greenhouseRules);
const workday = compileBundledAdapter(workdayRules);
const visible = (): boolean => true;
/** 认「网站此刻在要验证码」：不挂在适配器上，按适配器带着的那一份规则现认。 */
const resolveGh = (page: ParentNode, isVisible: (element: Element) => boolean) =>
  resolveEmailCodePrompt(greenhouse.emailVerification!, page, isVisible);

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(): void {
  document.body.innerHTML = fixture('greenhouse/security-code.html');
}

function addError(text: string): HTMLElement {
  const error = document.createElement('p');
  error.id = 'email-verification-error';
  error.className = 'helper-text helper-text--error';
  error.textContent = text;
  document.querySelector('.email-verification')!.append(error);
  return error;
}

function boxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[id^="security-input-"]'));
}

describe('规则：emailVerification 的形状', () => {
  const base = (): Record<string, unknown> => JSON.parse(JSON.stringify(greenhouseRules)) as Record<string, unknown>;
  const prompt = (rules: Record<string, unknown>) =>
    ((rules['emailVerification'] as Record<string, unknown>)['codePrompts'] as Record<string, unknown>[])[0]!;

  it('随包的 Greenhouse、Workday 两份按发布侧口径读得通', () => {
    const gh = parseVendorRuleset(greenhouseRules, { unknownTopLevelKeys: 'reject' });
    expect(gh.ok).toBe(true);
    if (gh.ok) {
      expect(gh.value.emailVerification?.codePrompts).toHaveLength(1);
      expect(gh.value.emailVerification?.codePrompts[0]?.length).toBe(8);
    }
    const wd = parseVendorRuleset(workdayRules, { unknownTopLevelKeys: 'reject' });
    expect(wd.ok).toBe(true);
    if (wd.ok) expect(wd.value.emailVerification?.codePrompts).toEqual([]);
  });

  it('缺省就是没有：老规则一个字不用改', () => {
    const rules = base();
    delete rules['emailVerification'];
    const parsed = parseVendorRuleset(rules);
    expect(parsed.ok && parsed.value.emailVerification).toBeNull();
  });

  it.each([
    ['位数太少', (r: Record<string, unknown>) => { prompt(r)['length'] = 3; }],
    ['位数太多', (r: Record<string, unknown>) => { prompt(r)['length'] = 13; }],
    ['认不得的字符集', (r: Record<string, unknown>) => { prompt(r)['charset'] = 'hex'; }],
    ['认不得的下一步', (r: Record<string, unknown>) => { prompt(r)['next'] = 'submit'; }],
    ['条目里多一个键', (r: Record<string, unknown>) => { prompt(r)['autoSubmit'] = true; }],
    ['有 outcomes 却没说网站在哪儿说话', (r: Record<string, unknown>) => { prompt(r)['errors'] = null; }],
    ['同一种结局写两条', (r: Record<string, unknown>) => { (prompt(r)['outcomes'] as unknown[]).push({ kind: 'wrong', text: { source: 'bad' } }); }],
    ['发件人是空的', (r: Record<string, unknown>) => { ((r['emailVerification'] as Record<string, Record<string, unknown>>)['mail']!)['from'] = []; }],
    ['标题写成了一段话', (r: Record<string, unknown>) => { ((r['emailVerification'] as Record<string, Record<string, unknown>>)['mail']!)['subject'] = 'x'.repeat(121); }],
  ])('%s：整份拒收', (_name, mutate) => {
    const rules = base();
    mutate(rules);
    expect(parseVendorRuleset(rules).ok).toBe(false);
  });

  it('正则只放行 i', () => {
    const rules = base();
    ((prompt(rules)['outcomes'] as Record<string, unknown>[])[0]!)['text'] = { source: 'expired', flags: 'g' };
    const parsed = parseVendorRuleset(rules);
    expect(parsed.ok ? null : parsed.code).toBe('RULES_REGEX_INVALID');
  });
});

describe('认出网站在要验证码（Greenhouse 的 Security code）', () => {
  it('交出的是那 8 格（按顺序）、8 位、字母数字、填好之后再提交一次', () => {
    mount();
    const prompt = resolveGh(document, visible);
    expect(prompt).not.toBeNull();
    expect(prompt!.inputs).toEqual(boxes());
    expect(prompt!.length).toBe(8);
    expect(prompt!.charset).toBe('alphanumeric');
    expect(prompt!.next).toBe('resubmit');
    expect(prompt!.error).toBeNull();
    expect(prompt!.filled).toBe(false);
    expect(prompt!.isCurrent()).toBe(true);
    expect(greenhouse.declaresEmailCodePrompts).toBe(true);
    expect(greenhouse.emailVerificationMail?.from[0]).toBe('no-reply@us.greenhouse-mail.io');
    expect(greenhouse.emailVerificationMail?.subject).toBe('Security code for your application to');
  });

  it('网站说发到了哪个邮箱：读出像邮箱的那一段（打了码的也照登；句末的句号不算）', () => {
    mount();
    expect(resolveGh(document, visible)?.recipient).toBe('a••••@e••••.test');
    const address = ['ada', 'example.test'].join('@');
    document.querySelector('legend')!.textContent = `A verification code was sent to ${address}. To submit your application, enter the 8-character code.`;
    expect(resolveGh(document, visible)?.recipient).toBe(address);
  });

  it('没有这一块、或者它收着：网站此刻没在要验证码', () => {
    document.body.innerHTML = fixture('greenhouse/security-code.html');
    document.querySelector('.email-verification')!.remove();
    expect(resolveGh(document, visible)).toBeNull();
    mount();
    const fieldset = document.querySelector('fieldset')!;
    expect(resolveGh(document, (element) => element !== fieldset)).toBeNull();
  });

  it.each([
    ['少了一格', () => { boxes()[7]!.remove(); }],
    ['有一格是密码框', () => { boxes()[3]!.type = 'password'; }],
    ['有一格被禁用', () => { boxes()[0]!.disabled = true; }],
    ['有一格只读', () => { boxes()[5]!.readOnly = true; }],
    ['页面上有两块', () => {
      const copy = document.querySelector('fieldset')!.cloneNode(true) as Element;
      for (const input of Array.from(copy.querySelectorAll('input'))) input.id = `${input.id}-copy`;
      document.querySelector('form')!.append(copy);
    }],
  ])('%s：说不清，认不出（浮层照旧请他去网站上输）', (_name, mutate) => {
    mount();
    mutate();
    expect(resolveGh(document, visible)).toBeNull();
  });

  it('有一格看不见：认不出', () => {
    mount();
    const hidden = boxes()[2]!;
    expect(resolveGh(document, (element) => element !== hidden)).toBeNull();
  });

  it.each([
    ['The security code you entered is invalid.', 'wrong'],
    ['Your security code has expired. Please resubmit to receive a new one.', 'expired'],
    ['Too many attempts. Please try again later.', 'tooMany'],
    ['Something went wrong on our side.', 'unrecognized'],
  ] as const)('网站说「%s」：%s', (text, kind) => {
    mount();
    const node = addError(text);
    const error = resolveGh(document, visible)?.error;
    expect(error?.kind).toBe(kind);
    expect(error?.text).toBe(text);
    expect(error?.node).toBe(node);
  });

  it('那一句收着、或是空的：当作没说', () => {
    mount();
    const node = addError('The security code you entered is invalid.');
    expect(resolveGh(document, (element) => element !== node)?.error).toBeNull();
    node.textContent = '  ';
    expect(resolveGh(document, visible)?.error).toBeNull();
  });

  it('8 格都填上了、字符对得上：filled；缺一格、或夹着别的字符：没填好', () => {
    mount();
    const all = boxes();
    'AB12CD34'.split('').forEach((char, index) => { all[index]!.value = char; });
    expect(resolveGh(document, visible)?.filled).toBe(true);
    all[7]!.value = '';
    expect(resolveGh(document, visible)?.filled).toBe(false);
    all[7]!.value = '!';
    expect(resolveGh(document, visible)?.filled).toBe(false);
  });

  it('认出之后那一块没了、或换了一格：isCurrent 当场判否', () => {
    mount();
    const prompt = resolveGh(document, visible)!;
    const first = boxes()[0]!;
    const replacement = first.cloneNode() as HTMLInputElement;
    first.replaceWith(replacement);
    expect(prompt.isCurrent()).toBe(false);
    mount();
    const again = resolveGh(document, visible)!;
    document.querySelector('.email-verification')!.remove();
    expect(again.isCurrent()).toBe(false);
  });

  it('Workday 只声明了邮件长什么样（验证是点链接）：没有验证码格可认', () => {
    expect(workday.declaresEmailCodePrompts).toBe(false);
    expect(workday.emailVerificationMail?.from).toEqual(['…@myworkday.com']);
    mount();
    expect(resolveEmailCodePrompt(workday.emailVerification!, document, visible)).toBeNull();
  });
});

describe('整理他输的那一串', () => {
  it.each([
    ['AB12CD34', 'AB12CD34'],
    [' ab12-cd34 ', 'ab12cd34'],
    ['AB12 CD34', 'AB12CD34'],
    ['ＡＢ１２ＣＤ３４', 'AB12CD34'],
    ['AB12CD3', null],
    ['AB12CD345', null],
    ['AB12CD3!', null],
  ] as const)('%s → %s', (raw, expected) => {
    expect(normalizeEmailCode(raw, 8, 'alphanumeric')).toBe(expected);
  });

  it('只要数字的那种：字母一律不收', () => {
    expect(normalizeEmailCode('123456', 6, 'digits')).toBe('123456');
    expect(normalizeEmailCode('12345A', 6, 'digits')).toBeNull();
  });
});

describe('写进网站那一格：只写他输的那一串，写完不提交', () => {
  function authority(capabilities: readonly ('set-text' | 'set-select')[] = ['set-text']) {
    const minted = testAuthority(null, 'fill', capabilities);
    const consumed = consumeAuthority(minted);
    if (!consumed.ok) throw new Error(consumed.code);
    return consumed.value;
  }
  const policy = (overrides: Partial<{ enabled: boolean; text: boolean }> = {}) => {
    const base = createBundledApplyPolicy(Date.now());
    return { ...base, enabled: overrides.enabled ?? true, capabilities: { ...base.capabilities, 'set-text': overrides.text ?? true } };
  };

  it('每格一个字符，逐格发 input/change/blur/focusout；读回一致；没有任何点击与提交', () => {
    mount();
    const prompt = resolveGh(document, visible)!;
    const seen: string[] = [];
    for (const type of ['input', 'change', 'blur', 'focusout', 'click', 'submit', 'keydown']) {
      document.addEventListener(type, (event) => { seen.push(event.type); }, true);
    }
    const auth = authority();
    const result = writeEmailCode({ prompt, code: ' ab12-cd34 ', authority: auth, policy: policy() });
    releaseAuthority(auth);
    expect(result).toEqual({ ok: true });
    expect(boxes().map((box) => box.value).join('')).toBe('ab12cd34');
    expect(seen.filter((type) => type === 'input')).toHaveLength(8);
    expect(seen).not.toContain('click');
    expect(seen).not.toContain('submit');
    expect(seen).not.toContain('keydown');
    expect(resolveGh(document, visible)?.filled).toBe(true);
  });

  it('位数或字符不对：一格都不碰', () => {
    mount();
    const prompt = resolveGh(document, visible)!;
    expect(writeEmailCode({ prompt, code: 'AB12', authority: authority(), policy: policy() })).toEqual({ ok: false, code: 'CODE_FORMAT' });
    expect(boxes().every((box) => box.value === '')).toBe(true);
  });

  it('写策略关着、set-text 关着、票没核销：一格都不碰', () => {
    mount();
    const prompt = resolveGh(document, visible)!;
    expect(writeEmailCode({ prompt, code: 'AB12CD34', authority: authority(), policy: policy({ enabled: false }) })).toEqual({ ok: false, code: 'POLICY_DISABLED' });
    expect(writeEmailCode({ prompt, code: 'AB12CD34', authority: authority(), policy: policy({ text: false }) })).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    const unconsumed = testAuthority(null, 'fill', ['set-text']);
    expect(writeEmailCode({ prompt, code: 'AB12CD34', authority: unconsumed, policy: policy() })).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
    expect(writeEmailCode({ prompt, code: 'AB12CD34', authority: authority(['set-select']), policy: policy() })).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(boxes().every((box) => box.value === '')).toBe(true);
  });

  it('认出之后那一块没了：不写', () => {
    mount();
    const prompt = resolveGh(document, visible)!;
    document.querySelector('.email-verification')!.remove();
    expect(writeEmailCode({ prompt, code: 'AB12CD34', authority: authority(), policy: policy() })).toEqual({ ok: false, code: 'PROMPT_GONE' });
  });

  it('网站把写进去的又改回去了：照实报 WRITE_REVERTED', () => {
    mount();
    const prompt = resolveGh(document, visible)!;
    const last = boxes()[7]!;
    last.addEventListener('input', () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(last, '');
    });
    expect(writeEmailCode({ prompt, code: 'AB12CD34', authority: authority(), policy: policy() })).toEqual({ ok: false, code: 'WRITE_REVERTED' });
  });
});

describe('验证码格从来不是填写计划的一部分', () => {
  it('网站在要验证码时扫描这张表：那 8 格不是字段（不排进计划、不送给 AI、不进「需要你」），别的栏照旧', () => {
    mount();
    const form = readApplyForm('greenhouse');
    expect(form).not.toBeNull();
    expect(form!.fields.some((field) => field.element.id.startsWith('security-input-'))).toBe(false);
    expect(form!.fields.some((field) => field.key === 'email')).toBe(true);
    const plan = buildApplyPlan(form!, { firstName: 'Ada', email: ['ada', 'example.test'].join('@') } as never);
    expect([...plan.entries, ...plan.skipped].some((entry) => (entry as { element?: Element }).element?.id.startsWith('security-input-'))).toBe(false);
    // 最终提交照旧认得出：验证码填进去之后他还要按它。
    expect(form!.finalSubmitControl?.element.textContent).toBe('Submit application');
  });

  it('别家没声明、标签写着「Security code」的一格：填写层一律交还本人', () => {
    expect(classifyManualOnly('Security code')).toBe('NEVER');
    expect(classifyManualOnly('Enter your security code')).toBe('NEVER');
  });
});
