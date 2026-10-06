// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConsentGateReading } from '@edaix/apply-kernel/contracts';

import { passConsentGate, type ConsentGatePassInput } from '../lib/consentGatePass';
import { isDockConsentGateChosen, isDockConsentGateSettled } from '../lib/consentGateNote';

/**
 * 替他过 Jobvite 的「数据同意」页（2026-10-04，负责人 D7）：在代填授权之下选他资料里的居住国那一项；默认的那一份网站当场
 * 自己提交、整页跳到申请表；要人点「Accept」的那几份交还本人——插件不按任何提交控件。选项文字照四家同意页的原文。
 */

afterEach(() => { document.body.innerHTML = ''; });

function page(options: readonly string[]) {
  document.body.innerHTML = `<form name="consentForm"><select id="jv-country-select">
    <option value="">Select your location of residence and language</option>
    ${options.map((text, index) => `<option value="p${index}">${text}</option>`).join('')}
  </select><div id="details" hidden></div></form>`;
  const form = document.querySelector('form')!;
  const residence = document.querySelector('select')!;
  const reading: ConsentGateReading = {
    form,
    residence,
    isCurrent: () => true,
    submitControls: () => Array.from(form.querySelectorAll('button[type="submit"]')),
  };
  return { form, residence, reading };
}

function run(reading: ConsentGateReading, over: Partial<ConsentGatePassInput> = {}) {
  const chosen: number[] = [];
  let leaving = false;
  let notes = 0;
  const stopper = new AbortController();
  let clock = 0;
  const input: ConsentGatePassInput = {
    allowed: () => true,
    read: () => reading,
    residence: 'United States',
    choose: (_reading, index) => { chosen.push(index); reading.residence!.selectedIndex = index; return true; },
    leaving: () => leaving,
    isVisible: (element) => !(element as HTMLElement).closest('[hidden]'),
    onChosen: () => { notes += 1; },
    signal: stopper.signal,
    wait: async (ms) => { clock += ms; },
    now: () => clock,
    budgetMs: 2_000,
    ...over,
  };
  return { input, chosen, notes: () => notes, leave: () => { leaving = true; }, stopper };
}

describe('替他选居住地', () => {
  it('网站选完就自己提交、整页跳走（默认的那一份）→ NAVIGATING；选的是他的居住国那一项；告诉 worker 一声', async () => {
    const { reading } = page(['US', 'Canadian-French', 'European Economic Area', 'Other Areas']);
    const harness = run(reading, { choose: (r, index) => { harness.chosen.push(index); r.residence!.selectedIndex = index; harness.leave(); return true; } });
    await expect(passConsentGate(harness.input)).resolves.toBe('NAVIGATING');
    expect(harness.chosen).toEqual([1]);
    expect(harness.notes()).toBe(1);
  });

  it('网站把条款与「Accept」摆出来（非默认的那一份）→ ACCEPT_BY_USER；插件不按它', async () => {
    const { reading, form } = page(['United States - English', 'Canada - English']);
    let clicked = 0;
    const harness = run(reading, {
      choose: (r, index) => {
        r.residence!.selectedIndex = index;
        form.insertAdjacentHTML('beforeend', '<div><p>Terms</p><button type="submit">I Accept</button></div>');
        form.querySelector('button')!.addEventListener('click', () => { clicked += 1; });
        return true;
      },
    });
    await expect(passConsentGate(harness.input)).resolves.toBe('ACCEPT_BY_USER');
    expect(reading.residence!.selectedIndex).toBe(1);
    expect(clicked).toBe(0);
  });

  it('没有代填授权、他按了停止：不选', async () => {
    const { reading } = page(['US']);
    const denied = run(reading, { allowed: () => false });
    await expect(passConsentGate(denied.input)).resolves.toBe('NOT_ALLOWED');
    expect(denied.chosen).toEqual([]);
    const stopped = run(reading);
    stopped.stopper.abort();
    await expect(passConsentGate(stopped.input)).resolves.toBe('NOT_ALLOWED');
    expect(stopped.chosen).toEqual([]);
  });

  it('说不准他该选哪一项（列表里没有他的国家、不止一项）→ NO_CHOICE，不选', async () => {
    const { reading } = page(['US', 'Canadian-French', 'European Economic Area', 'Other Areas']);
    const harness = run(reading, { residence: 'Germany' });
    await expect(passConsentGate(harness.input)).resolves.toBe('NO_CHOICE');
    expect(harness.chosen).toEqual([]);
  });

  it('写不进去 → FAILED；选上了网站一直没动静 → STILL_HERE', async () => {
    const { reading } = page(['US']);
    await expect(passConsentGate(run(reading, { choose: () => false }).input)).resolves.toBe('FAILED');
    const quiet = run(reading);
    await expect(passConsentGate(quiet.input)).resolves.toBe('STILL_HERE');
    expect(quiet.chosen).toEqual([1]);
  });

  it('已经是那一项（他自己选过）：不再写，照样等结局', async () => {
    const { reading, residence } = page(['US']);
    residence.selectedIndex = 1;
    const harness = run(reading);
    await expect(passConsentGate(harness.input)).resolves.toBe('STILL_HERE');
    expect(harness.chosen).toEqual([]);
  });
});

describe('接线：只在第一次扫描停在数据同意页、不是连填翻过来的那一页', () => {
  const read = (name: string) => readFileSync(resolve(__dirname, '..', 'entrypoints', name), 'utf8');

  it('apply.content.ts：代填授权两把钥匙、规则声明的下拉、内核写入、不按提交控件', () => {
    const content = read('apply.content.ts');
    const at = content.indexOf("outcome.stop === 'CONSENT_GATE'");
    expect(at).toBeGreaterThan(0);
    const block = content.slice(at - 120, at + 2500);
    expect(block).toContain("mode !== 'AFTER_ADVANCE'");
    // 「他同意着当前版本」是这一轮按下去那一刻现读的那一份（#142：撤回即失效，档案答复里不再带同意）。
    expect(block).toContain('const signingNow = await signingPending;');
    expect(block).toContain("allowed: () => runtime.fillPolicy.capabilities['sign-on-behalf'] === true && signedNow,");
    expect(block).toContain('read: () => readRuntimeConsentGate(runtime.mapping, document),');
    expect(block).toContain('choose: (reading, index) => chooseConsentGateResidence({ reading, index, proof: root, policy: runtime.fillPolicy }).ok,');
    expect(block).toContain('void sendToWorker(DOCK_CONSENT_GATE_CHOSEN).catch(() => {});');
    expect(block).toContain("dockHandle?.reportBlocked('CONSENT_GATE_ACCEPT');");
    // 网站没有自己跳走：收回那一声。
    expect(block).toContain('void sendToWorker(DOCK_CONSENT_GATE_SETTLED).catch(() => {});');
    expect(block).not.toMatch(/\.click\(\)|requestSubmit|\.submit\(/u);
    // 新一页照实说一句。
    expect(content).toContain('if ((reply as { consentGatePassed?: unknown } | null)?.consentGatePassed === true) {');
  });

  it('background.ts：只收顶层帧、我们自己的内容脚本；90 秒内另一份文档的报到才带上', () => {
    const worker = read('background.ts');
    const at = worker.indexOf('const chosen = isDockConsentGateChosen(message);');
    expect(at).toBeGreaterThan(0);
    expect(worker.slice(at, at + 300)).toContain('sender.frameId !== 0');
    expect(worker.slice(at, at + 500)).toContain('if (!chosen) consentGateTabs.delete(sender.tab.id);');
    expect(worker).toContain('const verdict = arrivesAfterSubmit(consentGateTabs.get(tabId), documentId, Date.now());');
    expect(worker).toContain('...(consentGatePassed ? { consentGatePassed: true } : {}),');
  });

  it('消息只认不带值的那一条', () => {
    expect(isDockConsentGateChosen({ kind: 'dock/consent-gate-chosen' })).toBe(true);
    expect(isDockConsentGateChosen({ kind: 'dock/consent-gate-chosen', residence: 'US' })).toBe(false);
    expect(isDockConsentGateChosen({ kind: 'dock/submit-pressed' })).toBe(false);
    expect(isDockConsentGateSettled({ kind: 'dock/consent-gate-settled' })).toBe(true);
    expect(isDockConsentGateSettled({ kind: 'dock/consent-gate-chosen' })).toBe(false);
  });
});
