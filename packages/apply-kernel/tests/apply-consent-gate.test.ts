/**
 * 申请表之前那一道「数据同意」页要说对（2026-10-04，bench-1003 第三节：Jobvite 8 页里 4 页先到这一道）。
 *
 * 那一页是 AngularJS 的 `form[name=consentForm]`（标题「Data Consent」），里面只有一个选居住地的下拉；选完、同意之后才
 * 整页跳到申请表（`div.jv-apply-form`）。从前锚点没命中，内核答 `ROOT_NOT_FOUND`，浮层说「这一页暂时认不出申请表，
 * 请刷新后再试」——刷新没用，他要先过这一道。规则声明了 `consentGate` 之后，内核答 `CONSENT_GATE`，浮层照实说要他做什么。
 * 这一版只认、不动手（替他同意是负责人 2026-10-04 的 D7，另一刀）。
 *
 * 夹具照 2026-10-04 在 jobs.jobvite.com/ninjaone/job/<id>/apply 只读抓到的结构（公开页面，没有任何人的资料）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import bamboohr from '../../apply-rules/rules/bamboohr.json';
import jobvite from '../../apply-rules/rules/jobvite.json';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { readRuntimeApplyFormResult, type ResolvedRuntimeApplyAdapter } from '../src/runtimeRegistry';

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

const CONSENT_PAGE = `
  <article class="jv-page-body" role="main">
    <div class="jv-wrapper"><h3>Data Consent</h3>
      <form name="consentForm" class="jv-form" method="POST" action="/acme/job/o1/apply">
        <div><label for="jv-country-select">Location of Residence and Language:</label></div>
        <select id="jv-country-select" required>
          <option value="">Select your location of residence and language</option>
          <option value="p1">Global Acme Candidate Privacy Policy - English</option>
        </select>
        <div><a class="jv-button" href="/acme/job/o1">Back</a></div>
      </form>
    </div>
  </article>`;

const APPLY_PAGE = `
  <div class="jv-form jv-apply-form"><form>
    <label for="first">First Name*</label><input id="first" autocomplete="given-name" required>
    <label for="last">Last Name*</label><input id="last" autocomplete="family-name" required>
    <label for="mail">Email*</label><input id="mail" autocomplete="email" required>
  </form></div>`;

afterEach(() => { document.body.innerHTML = ''; });

const adapter = () => compileBundledAdapter(jobvite as unknown as Ruleset);
const resolved = () => ({ adapter: adapter(), vendor: 'jobvite' }) as unknown as ResolvedRuntimeApplyAdapter;

describe('Jobvite：申请页第一步是数据同意页', () => {
  it('同意页 → 内核答 CONSENT_GATE（从前是 ROOT_NOT_FOUND：「认不出申请表，请刷新」）', () => {
    document.body.innerHTML = CONSENT_PAGE;
    expect(adapter().hasConsentGate?.(document)).toBe(true);
    expect(adapter().resolveRoot(document)).toBeNull();
    expect(readRuntimeApplyFormResult(resolved(), '/acme/job/o1/apply', document)).toEqual({ ok: false, stop: 'CONSENT_GATE' });
  });

  it('过了同意、申请表出来了 → 不是同意页，照常扫表', () => {
    document.body.innerHTML = APPLY_PAGE;
    expect(adapter().hasConsentGate?.(document)).toBe(false);
    expect(readRuntimeApplyFormResult(resolved(), '/acme/job/o1/apply', document)).toMatchObject({ ok: true });
  });

  it('两样都没有 → 照旧 ROOT_NOT_FOUND（那是别的原因）', () => {
    document.body.innerHTML = '<main><h1>Careers</h1></main>';
    expect(readRuntimeApplyFormResult(resolved(), '/acme/job/o1/apply', document)).toEqual({ ok: false, stop: 'ROOT_NOT_FOUND' });
  });
});

describe('没有声明 consentGate 的厂商，行为一个字都不变', () => {
  it('BambooHR：同一页上永远答否；它自己的「还没打开」照旧', () => {
    document.body.innerHTML = `${CONSENT_PAGE}<button data-bi-id="careers-site-apply-button" type="button">Apply for This Job</button>`;
    const bamboo = compileBundledAdapter(bamboohr as unknown as Ruleset);
    expect(bamboo.hasConsentGate?.(document)).toBe(false);
    expect(bamboo.hasUnopenedApplyForm(document)).toBe(true);
  });
});

describe('consentGate 的解析', () => {
  const withGate = (gate: unknown) => parseVendorRuleset({ ...(jobvite as object), consentGate: gate });

  it('缺席与 null 同义；只写 form 就行，其余三项可缺省', () => {
    const { consentGate: _omitted, ...without } = jobvite as Record<string, unknown>;
    expect(parseVendorRuleset(without)).toMatchObject({ ok: true, value: { consentGate: null } });
    expect(withGate(null)).toMatchObject({ ok: true, value: { consentGate: null } });
    expect(withGate({ form: 'form[name="consentForm"]' }))
      .toMatchObject({ ok: true, value: { consentGate: { form: 'form[name="consentForm"]', residence: null, text: null, accept: null } } });
    expect(withGate({ form: 'f', residence: '#r', text: 'p', accept: 'button' }))
      .toMatchObject({ ok: true, value: { consentGate: { form: 'f', residence: '#r', text: 'p', accept: 'button' } } });
  });

  it('form 必须是非空字符串；写了的可选项也得是非空字符串；多一个键整份拒收', () => {
    expect(withGate({})).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(withGate({ form: '' })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(withGate({ form: 'f', accept: '' })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(withGate({ form: 'f', accept: 3 })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(withGate({ form: 'f', decline: 'a' })).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
    expect(withGate('form')).toMatchObject({ ok: false, code: 'RULES_MALFORMED' });
  });

  it('选择器语法非法：查不动就答否，不抛', () => {
    document.body.innerHTML = CONSENT_PAGE;
    const broken = withGate({ form: 'form[[' });
    expect(broken).toMatchObject({ ok: true });
    if (!broken.ok) throw new Error(broken.code);
    expect(compileBundledAdapter(broken.value as unknown as Ruleset).hasConsentGate?.(document)).toBe(false);
  });
});
