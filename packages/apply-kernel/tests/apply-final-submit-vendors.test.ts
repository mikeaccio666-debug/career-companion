import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import bamboohrRules from '@edaix/apply-rules/bamboohr.json';
import doverRules from '@edaix/apply-rules/dover.json';
import ripplingRules from '@edaix/apply-rules/rippling.json';
import { installBundledApplyAdapters } from '../src/bundledAdapters';
import type { ApplyVendor } from '../src/contracts';
import { readApplyForm } from '../src/registry';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

installBundledApplyAdapters();

/**
 * 在浮层里提交的厂商（2026-10-04 负责人：Greenhouse、Workable 之外再开几家）。
 *
 * 夹具照 2026-10-04 在真实在招岗位上的只读实测手写（每家 5 个以上岗位，只读 DOM：没有输入、没有提交），只留结构与钩子。
 * 这里锁的是规则声明的那一颗：认得出、只认那一颗、多一颗或变了样就认不出（fail closed）。按不按、什么时候按，
 * 是扩展 submitController 的事（它只在用户按下浮层里的「提交」之后、核过开关与这一颗的身份才按）。
 */

const fixture = (path: string): string => readFileSync(resolve(__dirname, 'fixtures', path), 'utf8');

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(path: string): void {
  document.body.innerHTML = fixture(path);
}

function read(vendor: ApplyVendor) {
  const form = readApplyForm(vendor);
  expect(form, `${vendor} 的表要认得出来`).not.toBeNull();
  return form!;
}

describe('三份规则都声明了最终提交，而且仍是 native-submit', () => {
  it.each([
    ['dover', doverRules],
    ['rippling', ripplingRules],
    ['bamboohr', bamboohrRules],
  ] as const)('%s', (_vendor, rules) => {
    const parsed = parseVendorRuleset(rules, { unknownTopLevelKeys: 'reject' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.finalSubmitControl?.activation).toBe('native-submit');
  });
});

describe('Dover：表里唯一的那一颗「Apply」', () => {
  it('认出的是表里那一颗原生提交，属于扫描的这张表', () => {
    mount('dover/final-submit.html');
    const form = read('dover');
    const control = form.finalSubmitControl;
    expect(control).not.toBeNull();
    expect(control!.element.type).toBe('submit');
    expect(control!.element.textContent?.trim()).toBe('Apply');
    expect(control!.form).toBe(document.querySelector('form'));
    expect(control!.isCurrent()).toBe(true);
  });

  it('表里多出一颗原生提交：认不出（不猜是哪一颗）', () => {
    mount('dover/final-submit.html');
    const extra = document.createElement('button');
    extra.type = 'submit';
    extra.textContent = 'Apply';
    document.querySelector('form')!.append(extra);
    expect(read('dover').finalSubmitControl).toBeNull();
  });

  it('那一颗变成了 type=button、或网站正在提交（disabled）：认不出', () => {
    mount('dover/final-submit.html');
    document.querySelector('button[type="submit"]')!.setAttribute('type', 'button');
    expect(read('dover').finalSubmitControl).toBeNull();

    mount('dover/final-submit.html');
    (document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled = true;
    expect(read('dover').finalSubmitControl).toBeNull();
  });

  it('认出之后又多了一颗：isCurrent 当场判否', () => {
    mount('dover/final-submit.html');
    const control = read('dover').finalSubmitControl!;
    const extra = document.createElement('button');
    extra.type = 'submit';
    document.querySelector('form')!.append(extra);
    expect(control.isCurrent()).toBe(false);
  });
});

describe('Rippling：只认写着「Apply」的那一颗，而且要等网站放开它', () => {
  function enable(): void {
    const button = document.querySelector('button[type="submit"]')!;
    button.setAttribute('data-disabled', 'false');
    button.removeAttribute('aria-disabled');
  }

  it('必填没填好（aria-disabled）：扫描那一刻认不出，填好之前再认一次也认不出', () => {
    mount('rippling/final-submit.html');
    const form = read('rippling');
    expect(form.finalSubmitControl).toBeNull();
    expect(form.resolveFinalSubmitControl?.()).toBeNull();
  });

  it('网站放开之后：同一套判据再认一次就认得出（扫描时禁用着的那一颗）', () => {
    mount('rippling/final-submit.html');
    const form = read('rippling');
    enable();
    const late = form.resolveFinalSubmitControl?.() ?? null;
    expect(late).not.toBeNull();
    expect(late!.element.getAttribute('data-testid')).toBe('Apply');
    expect(late!.form).toBe(document.querySelector('form'));
    expect(late!.isCurrent()).toBe(true);
    // 网站又禁用了它（比如他清空了一栏）：当场判否。
    late!.element.setAttribute('aria-disabled', 'true');
    expect(late!.isCurrent()).toBe(false);
  });

  it('写着「Continue」（后面还有页）：那是翻页，不是最终提交——认不出', () => {
    mount('rippling/final-submit.html');
    const button = document.querySelector('button[type="submit"]')!;
    button.setAttribute('data-testid', 'Continue');
    button.textContent = 'Continue';
    enable();
    const form = read('rippling');
    expect(form.finalSubmitControl).toBeNull();
    expect(form.resolveFinalSubmitControl?.()).toBeNull();
  });
});

describe('BambooHR：表外操作栏里、用 form 属性认领这张表的「Submit Application」', () => {
  it('认出的是表外那一颗，它的 form 就是扫描的这张表', () => {
    mount('bamboohr/final-submit.html');
    const control = read('bamboohr').finalSubmitControl;
    expect(control).not.toBeNull();
    expect(control!.element.textContent?.trim()).toBe('Submit Application');
    expect(control!.element.closest('form')).toBeNull();
    expect(control!.form).toBe(document.querySelector('form#job-application-form'));
    expect(control!.isCurrent()).toBe(true);
  });

  it('同一个 form 属性的原生提交整页有两颗：认不出', () => {
    mount('bamboohr/final-submit.html');
    const twin = document.createElement('button');
    twin.type = 'submit';
    twin.setAttribute('form', 'job-application-form');
    document.body.append(twin);
    expect(read('bamboohr').finalSubmitControl).toBeNull();
  });

  it('表里自己还有一颗原生提交（这张表的提交不止一颗）：认不出', () => {
    mount('bamboohr/final-submit.html');
    const inside = document.createElement('button');
    inside.type = 'submit';
    document.querySelector('form')!.append(inside);
    expect(read('bamboohr').finalSubmitControl).toBeNull();
  });

  it('form 属性指着别的表、或那一颗被挪走了：认不出；认出之后被改了指向，isCurrent 当场判否', () => {
    mount('bamboohr/final-submit.html');
    const other = document.createElement('form');
    other.id = 'other-form';
    document.body.append(other);
    document.querySelector('button[form]')!.setAttribute('form', 'other-form');
    expect(read('bamboohr').finalSubmitControl).toBeNull();

    mount('bamboohr/final-submit.html');
    const control = read('bamboohr').finalSubmitControl!;
    const elsewhere = document.createElement('form');
    elsewhere.id = 'elsewhere';
    document.body.append(elsewhere);
    control.element.setAttribute('form', 'elsewhere');
    expect(control.isCurrent()).toBe(false);
  });

  it('表单身份变了（action 被改）：isCurrent 判否', () => {
    mount('bamboohr/final-submit.html');
    const control = read('bamboohr').finalSubmitControl!;
    control.form.setAttribute('action', '/somewhere-else');
    expect(control.isCurrent()).toBe(false);
  });
});

describe('表外认领只给 form 属性：别的情形照旧只在扫描根里找', () => {
  it('Greenhouse 式的选择器：表外有一颗没写 form 属性的原生提交，认不出、也不往表外找', () => {
    document.body.innerHTML = `
      <form><input name="firstName" type="text" /><input name="email" type="email" /></form>
      <button type="submit">Apply</button>`;
    const adapter = compileBundledAdapter(doverRules);
    const root = adapter.resolveRoot(document)!;
    expect(root).not.toBeNull();
    expect(adapter.resolveFinalSubmitControl(root, adapter.scan(root))).toBeNull();
  });
});
