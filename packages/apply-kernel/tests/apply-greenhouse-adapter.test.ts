import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, summarizePlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { readApplyForm } from '../src/registry';
import { installBundledApplyAdapters } from '../src/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


/**
 * Greenhouse adapter, built against DOM captured live from
 * job-boards.greenhouse.io on 2026-07-28. The fixture reproduces the real
 * markup: stable ids + autocomplete tokens for the core fields, an opaque
 * per-posting id for the custom question, a file input for the resume, and a
 * recaptcha textarea that must be ignored entirely.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function mountGreenhouseFixture(): void {
  document.body.innerHTML = `
    <form id="application-form" class="application--form">
      <label for="first_name">First Name*</label>
      <input id="first_name" type="text" autocomplete="given-name" required />

      <label for="last_name">Last Name*</label>
      <input id="last_name" type="text" autocomplete="family-name" required />

      <label for="email">Email*</label>
      <input id="email" type="text" autocomplete="email" required />

      <label for="phone">Phone</label>
      <input id="phone" type="tel" autocomplete="off" />

      <label for="question_14364081008">LinkedIn Profile</label>
      <input id="question_14364081008" type="text" />

      <label for="question_99">Website / Portfolio</label>
      <input id="question_99" type="text" />

      <label for="resume">Attach</label>
      <input id="resume" type="file" />

      <textarea name="g-recaptcha-response"></textarea>
      <input type="hidden" name="authenticity_token" value="x" />
      <button type="submit" class="btn btn--rounded">Submit application</button>
    </form>`;
}

function mountGreenhouseFixtureFile(name: string): void {
  document.documentElement.innerHTML = readFileSync(
    resolve(process.cwd(), 'tests/fixtures/greenhouse', name),
    'utf8',
  );
}

describe('Greenhouse application adapter', () => {
  it('accepts only the exact modern candidate route', () => {
    expect(greenhouseAdapter.isApplyPath('/discord/jobs/8599937002')).toBe(true);
    expect(greenhouseAdapter.isApplyPath('/discord/jobs/8599937002/')).toBe(true);
    for (const path of [
      '/admin/discord/jobs/8599937002',
      '/discord/jobs/8599937002/admin',
      '/jobs/8599937002',
    ]) {
      expect(greenhouseAdapter.isApplyPath(path), path).toBe(false);
    }
  });

  it('maps the core fields from stable ids with full confidence', () => {
    mountGreenhouseFixture();
    const form = readApplyForm('greenhouse');
    expect(form).not.toBeNull();
    expect(form!.vendor).toBe('greenhouse');
    expect(form!.finalSubmitControl?.element.textContent).toContain('Submit application');
    expect(form!.finalSubmitControl?.isCurrent()).toBe(true);

    const byKey = new Map(form!.fields.filter((f) => f.key).map((f) => [f.key, f]));
    expect(byKey.get('firstName')?.confidence).toBe(1);
    expect(byKey.get('lastName')?.confidence).toBe(1);
    expect(byKey.get('email')?.confidence).toBe(1);
    expect(byKey.get('phone')?.confidence).toBe(1);
  });

  it('invalidates the exact final control when effective form submission semantics drift', () => {
    mountGreenhouseFixture();
    const actionDescriptor = readApplyForm('greenhouse')!;
    actionDescriptor.finalSubmitControl!.form.setAttribute('action', '/changed-destination');
    expect(actionDescriptor.finalSubmitControl?.isCurrent()).toBe(false);

    mountGreenhouseFixture();
    const methodDescriptor = readApplyForm('greenhouse')!;
    methodDescriptor.finalSubmitControl!.form.method = 'post';
    expect(methodDescriptor.finalSubmitControl?.isCurrent()).toBe(false);
  });

  it('refuses final authority when a scanned field is associated to another form', () => {
    mountGreenhouseFixture();
    const other = document.createElement('form');
    other.id = 'other-form';
    document.body.append(other);
    document.querySelector('#first_name')!.setAttribute('form', other.id);

    expect(readApplyForm('greenhouse')?.finalSubmitControl).toBeNull();
  });

  it('resolves custom questions by LABEL, since their ids are per-posting', () => {
    mountGreenhouseFixture();
    const form = readApplyForm('greenhouse')!;
    const linkedin = form.fields.find((f) => f.key === 'linkedinUrl');
    const portfolio = form.fields.find((f) => f.key === 'portfolioUrl');
    expect(linkedin).toBeDefined();
    expect(portfolio).toBeDefined();
    // Label prose is a weaker signal than a declared id/autocomplete token.
    expect(linkedin!.confidence).toBeLessThan(1);
    expect(linkedin!.confidence).toBeGreaterThan(0.5);
    // The opaque id must never leak into the label shown to the user.
    expect(linkedin!.label).toBe('LinkedIn Profile');
  });

  /**
   * ⚠️ **这条测试锁的是一个差点静默失效的路径。**
   *
   * Greenhouse 的简历控件标签是 `"Attach"`（实测 2026-08-01，真实申请页），
   * 不含 resume/cv —— 只按标签判会让**最主流的一家**的简历上传永远不触发，
   * 而且面板会显示"需手动填"，看起来像我们不支持这个控件。
   * 它的 `id` 是 `resume`，所以守卫必须同时看属性身份（与蜜罐守卫同一形状）。
   */
  it('resume file input 归 file kind，且靠 id 而不是标签认出来', () => {
    mountGreenhouseFixture();
    const form = readApplyForm('greenhouse')!;
    const resume = form.fields.find(
      (field) => field.element instanceof HTMLInputElement && field.element.type === 'file',
    );
    expect(resume).toMatchObject({ kind: 'file', key: null, label: 'Attach' });
    expect(
      (resume?.element as HTMLInputElement).id,
      '这个 fixture 的 id 不是 resume，测试就证明不了"靠 id 认出来"',
    ).toBe('resume');

    // 有简历时它进计划；没有简历时报缺资料 —— 两者都不该是"不支持这个控件"。
    const withResume = buildApplyPlan(form, {}, { resumeFileName: 'Ada.pdf', resumeHostConfirmed: true });
    expect(withResume.entries.some((entry) => entry.key === 'resumeFile')).toBe(true);

    const withoutResume = buildApplyPlan(form, {});
    expect(
      withoutResume.skipped.find((item) => item.label === 'Attach')?.reason,
      '没有简历应该是"去补资料"，不是"这个控件我们填不了"',
    ).toBe('NO_VALUE');
  });

  it('ignores captcha and hidden inputs entirely', () => {
    mountGreenhouseFixture();
    const form = readApplyForm('greenhouse')!;
    const names = form.fields.map((f) => (f.element as HTMLInputElement).name || '');
    expect(names.some((n) => n.includes('recaptcha'))).toBe(false);
    expect(names.some((n) => n === 'authenticity_token')).toBe(false);
  });

  it('strips the required marker from labels', () => {
    mountGreenhouseFixture();
    const form = readApplyForm('greenhouse')!;
    const first = form.fields.find((f) => f.key === 'firstName')!;
    expect(first.label).toBe('First Name');
    expect(first.required).toBe(true);
  });

  it('fails closed on a page with inputs but no recognisable application field', () => {
    document.body.innerHTML = `
      <form id="application-form"><label for="q">Search jobs</label><input id="q" type="search" /></form>`;
    expect(readApplyForm('greenhouse')).toBeNull();
  });

  it('fails closed on a page with no controls at all', () => {
    document.body.innerHTML = '<main><form id="application-form"><p>Job description only</p></form></main>';
    expect(readApplyForm('greenhouse')).toBeNull();
  });

  it('只扫描 Greenhouse 显式 application-form，绝不把页脚 #email 放进计划', () => {
    mountGreenhouseFixtureFile('application-form-with-footer.html');
    const form = readApplyForm('greenhouse')!;
    const scopes = form.fields.map((field) => field.element.getAttribute('data-fixture'));

    expect(scopes).toContain('application-email');
    expect(scopes).not.toContain('newsletter-email');
    expect(form.fields.find((field) => field.key === 'email')?.label).toBe('Application Email');

    const plan = buildApplyPlan(form, { email: 'candidate@example.test' });
    expect(plan.entries.every((entry) => entry.element.getAttribute('data-fixture') !== 'newsletter-email')).toBe(true);
  });

  it('页面只有页脚订阅框、没有显式 application-form 时整体 fail-closed', () => {
    document.body.innerHTML = `
      <footer>
        <form><label for="email">Subscribe to our newsletter</label><input id="email" type="email" /></form>
      </footer>`;

    expect(readApplyForm('greenhouse')).toBeNull();
  });

  it('pathname-only authority rejects the legacy embed route whose job identity lives in query', () => {
    mountGreenhouseFixtureFile('legacy-embed-application-form.html');

    expect(greenhouseAdapter.isApplyPath('/embed/job_app')).toBe(false);
    // 子帧声明（P2-10，2026-09-21）：官方嵌入帧里同一张表才放行，且只放行规则点名的那条
    // 嵌入路径；顶层帧上它照旧不是申请页——岗位身份在 query 里，pathname-only authority 不认它。
    expect(greenhouseAdapter.isApplyPath('/embed/job_app', { embedded: true })).toBe(true);
    expect(greenhouseAdapter.isApplyPath('/embed/job_board', { embedded: true })).toBe(false);
    expect(greenhouseAdapter.isApplyPath('/acme/jobs/1', { embedded: true })).toBe(true);
    // The fixture remains useful for parser-only rehearsal; top-frame path
    // authorization stays closed until a value-free route identity exists.
    const form = readApplyForm('greenhouse')!;
    expect(form.fields.map((field) => field.element.getAttribute('data-fixture'))).toEqual([
      'embed-first-name',
      'embed-email',
    ]);
    expect(form.fields.find((field) => field.key === 'email')?.label).toBe('Email');
  });

  it('脱离 document 的表单只读自身 container 内的 label，不向全局逃逸', () => {
    document.body.innerHTML = '<label for="first_name">Global decoy label</label>';
    const page = document.createDocumentFragment();
    const application = document.createElement('form');
    application.id = 'application-form';
    application.innerHTML = `
      <label for="first_name">Application First Name</label>
      <input id="first_name" type="text" autocomplete="given-name" />`;
    page.append(application);

    expect(page.querySelectorAll('form#application-form')).toHaveLength(1);
    const root = greenhouseAdapter.resolveRoot(page);
    expect(root?.querySelectorAll('input')).toHaveLength(1);
    const firstName = application.querySelector('input')!;
    expect(root?.querySelectorAll('input')[0]).toBe(firstName);
    expect(root?.isExcluded(firstName)).toBe(false);
    expect(greenhouseAdapter.scan(root!)).toHaveLength(1);
    const form = readApplyForm('greenhouse', page)!;
    expect(form.fields.find((field) => field.key === 'firstName')?.label).toBe('Application First Name');
  });
});
