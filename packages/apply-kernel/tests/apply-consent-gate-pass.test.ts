/**
 * 替他过 Jobvite 的「数据同意」页（2026-10-04，负责人 D7）。
 *
 * 那一页只有一个下拉「Location of Residence and Language」，每一项是一份隐私条款（按居住地与语言分）。选中之后网站去取
 * 那一份条款：默认的那一份它当场自己提交、整页跳到申请表；别的那几份把条款摆出来，下面一颗「Accept」。负责人决定：
 * 在代填授权之下（资料页单独同意过当前版本 ∧ 运行时包放行 `sign-on-behalf`）可以替他选——选的是他资料里的居住国那一项；
 * 网站把条款摆出来、要人点「Accept」的那几份，这一版交还本人。
 *
 * 判据在 dict/signOnBehalf.ts：选哪一项（`consentGateResidenceIndex`）。夹具里的选项文字照 2026-10-04 在四家 Jobvite
 * 同意页上只读抓到的原文（ninjaone、ookla、ezra、internetbrands；公开页面，没有任何人的资料）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import jobvite from '../../apply-rules/rules/jobvite.json';
import { chooseConsentGateResidence } from '../src/consentGate';
import { consentGateResidenceIndex } from '../src/dict/consentGate';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { createBundledApplyPolicy } from '../src/policy';
import { captureTrustedShadowGesture, type TrustedGestureProof } from '../src/grant';

/** happy-dom 造不出受信点击：这里只模拟「来自我方 shadow 的受信点击」那一道边界（与账号墙的测试同一个做法）。 */
function createGestureRoot(now = Date.now()): TrustedGestureProof {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  const event = new MouseEvent('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [button, shadowRoot, host] });
  const proof = captureTrustedShadowGesture(event, shadowRoot, now);
  if (proof === null) throw new Error('test proof rejected');
  return proof;
}

type Ruleset = Parameters<typeof compileBundledAdapter>[0];

const opts = (...texts: string[]) => texts.map((text, index) => ({ index: index + 1, text }));

describe('选哪一项：他资料里的居住国', () => {
  it('四家的原文：美国居民各选对那一项', () => {
    expect(consentGateResidenceIndex(opts('Global NinjaOne Candidate Privacy Policy - English'), 'United States')).toBe(1);
    expect(consentGateResidenceIndex(opts('US', 'Canadian-French', 'European Economic Area', 'Other Areas'), 'United States')).toBe(1);
    expect(consentGateResidenceIndex(opts('Australia - English', 'Canada - English', 'Canada - French', 'United States - English', 'United Kingdom - English'), 'US')).toBe(4);
    expect(consentGateResidenceIndex(opts('United States & Other (not in list below)', 'United Kingdom', 'France', 'Canada'), 'USA')).toBe(1);
  });

  it('同一国几种语言：挑英文那一份；挑不出唯一的一份就交还本人', () => {
    expect(consentGateResidenceIndex(opts('Canada - English', 'Canada - French'), 'Canada')).toBe(1);
    expect(consentGateResidenceIndex(opts('Canada - French', 'Canada - Español'), 'Canada')).toBeNull();
  });

  it('列表里没有他的国家：只有一份（全球统一的条款）就选它；不止一份就交还本人——不替他猜「Other Areas」', () => {
    expect(consentGateResidenceIndex(opts('Global Acme Candidate Privacy Policy - English'), 'Germany')).toBe(1);
    expect(consentGateResidenceIndex(opts('US', 'Canadian-French', 'European Economic Area', 'Other Areas'), 'Germany')).toBeNull();
  });

  it('资料里没有居住国：只有一份才选', () => {
    expect(consentGateResidenceIndex(opts('Global Acme Candidate Privacy Policy - English'), null)).toBe(1);
    expect(consentGateResidenceIndex(opts('US', 'Other Areas'), null)).toBeNull();
    expect(consentGateResidenceIndex(opts('US', 'Other Areas'), '  ')).toBeNull();
  });

  it('选项里掺了别的授权（营销、短信、人才库……）：不选，交还本人', () => {
    expect(consentGateResidenceIndex(opts('United States - English, and send me marketing emails'), 'US')).toBeNull();
    expect(consentGateResidenceIndex(opts('Global privacy policy and talent community'), 'US')).toBeNull();
  });
});

const CONSENT_PAGE = (options: string) => `
  <article class="jv-page-body" role="main">
    <div class="jv-wrapper"><h3>Data Consent</h3>
      <form name="consentForm" class="jv-form" method="POST" action="/acme/job/o1/apply">
        <div><label for="jv-country-select">Location of Residence and Language:</label></div>
        <select id="jv-country-select" required>
          <option value="">Select your location of residence and language</option>
          ${options}
        </select>
      </form>
    </div>
  </article>`;

afterEach(() => { document.body.innerHTML = ''; });

const adapter = () => compileBundledAdapter(jobvite as unknown as Ruleset);
const policy = (signOnBehalf: boolean) => {
  const base = createBundledApplyPolicy(Date.now());
  return { ...base, enabled: true, capabilities: { ...base.capabilities, 'sign-on-behalf': signOnBehalf } };
};

describe('读同意页：规则声明的居住地下拉', () => {
  it('同意页上 → 交出表与下拉；申请表出来之后（锚点命中）→ 不是同意页', () => {
    document.body.innerHTML = CONSENT_PAGE('<option value="p1">US</option>');
    const reading = adapter().readConsentGate?.(document) ?? null;
    expect(reading?.residence?.id).toBe('jv-country-select');
    expect(reading?.isCurrent()).toBe(true);
    expect(reading?.submitControls()).toEqual([]);
    document.body.innerHTML = '<div class="jv-form jv-apply-form"><form><input id="first" autocomplete="given-name"></form></div>';
    expect(adapter().readConsentGate?.(document) ?? null).toBeNull();
  });
});

describe('网站把条款摆出来、要人点「Accept」：交出那张表里的提交控件（插件不按，只量看不看得见）', () => {
  it('非默认的那一份：条款 + 一颗 button[type=submit]', () => {
    document.body.innerHTML = CONSENT_PAGE('<option value="p1">US</option>').replace('</select>', '</select><div><p>Terms</p><button type="submit" class="jv-button-primary">I Accept</button><a href="/acme/job/o1">Decline</a></div>');
    const reading = adapter().readConsentGate!(document)!;
    expect(reading.submitControls().map((element) => element.textContent)).toEqual(['I Accept']);
  });
});

describe('替他选：一次真实点击、放行 sign-on-behalf，写下拉的那一项、派 input/change', () => {
  it('选上那一项、网站收到 change；读回是那一项', () => {
    document.body.innerHTML = CONSENT_PAGE('<option value="p1">US</option><option value="p2">Other Areas</option>');
    const reading = adapter().readConsentGate!(document)!;
    const events: string[] = [];
    reading.residence!.addEventListener('change', () => events.push('change'));
    reading.residence!.addEventListener('input', () => events.push('input'));
    const result = chooseConsentGateResidence({ reading, index: 1, proof: createGestureRoot(), policy: policy(true) });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(reading.residence!.selectedIndex).toBe(1);
    expect(events).toEqual(['input', 'change']);
  });

  it('运行时包没放行 sign-on-behalf：一下都不动', () => {
    document.body.innerHTML = CONSENT_PAGE('<option value="p1">US</option>');
    const reading = adapter().readConsentGate!(document)!;
    expect(chooseConsentGateResidence({ reading, index: 1, proof: createGestureRoot(), policy: policy(false) }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(reading.residence!.selectedIndex).toBe(0);
  });

  it('同意页换了（下拉不是那一个了）、那一项是占位或停用：不动', () => {
    document.body.innerHTML = CONSENT_PAGE('<option value="p1" disabled>US</option>');
    const reading = adapter().readConsentGate!(document)!;
    expect(chooseConsentGateResidence({ reading, index: 0, proof: createGestureRoot(), policy: policy(true) }))
      .toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
    expect(chooseConsentGateResidence({ reading, index: 1, proof: createGestureRoot(), policy: policy(true) }))
      .toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' });
    document.body.innerHTML = CONSENT_PAGE('<option value="p1">US</option>');
    expect(chooseConsentGateResidence({ reading, index: 1, proof: createGestureRoot(), policy: policy(true) }))
      .toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
  });
});
