// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditView } from '@edaix/apply-kernel/audit';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { readApplyForm } from '@edaix/apply-kernel/registry';
import { dockProgressFromAudit } from '../lib/autofillDockProgress';
import { isNeed, toDockRow } from '../lib/dock/rows';
import { fillFromGesture } from '../lib/gestureFill';
import type { KernelFillAudit } from '../lib/kernelFiller';

installBundledApplyAdapters();

/**
 * 附上简历之后宿主自己解析、改写别的栏（2026-09-24 测试台，已合 #89–#93）。
 *
 *  · Rippling：我们填好的姓名、邮箱、电话、LinkedIn 被它的解析改写，行上落「网站改掉了这一项」；我们没值
 *    可填的「Current company」被它填上，浮层却记成「你补上了」。
 *  · Lever：我们填好的地点被清空，审计与浮层却一直说「已填」。
 *
 * 竞品是先附简历、等宿主解析完、再填并以资料为准覆盖。我们保留文件排最后（Greenhouse 那条快路），改成：
 * 附上简历之后等宿主安静下来，再在同一次点击的第二遍里——
 *  · 我们写成、随后被宿主清空或改写、用户没碰过的栏：资料里的值为准，重写一次，不循环；再被改掉就照实报；
 *  · 我们没写、宿主从简历里读出来填上的栏：留着网站的值，照实说「网站从你的简历里读的」，不算用户补的；
 *  · 用户在这段时间亲手动过的栏：一概不碰、不替网站邀功。
 * 不解析的宿主只多等一个安静窗口；按停止立刻结束等待。
 *
 * 夹具全是合成文字，没有任何真实用户资料。
 */

const intervals: Array<ReturnType<typeof setInterval>> = [];
afterEach(() => {
  for (const handle of intervals.splice(0)) clearInterval(handle);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

function trustedGesture() {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  button.addEventListener('click', (event) => { proof = captureTrustedShadowGesture(event, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click'));
  expect(proof, '前置条件：凭证要取得到').not.toBeNull();
  return proof!;
}

function livePolicy(): ApplyPolicy {
  return { ...createBundledApplyPolicy(), notAfter: Date.now() + 60_000 };
}

const scanNow = () => {
  const descriptor = readApplyForm('greenhouse', document);
  expect(descriptor, '前置条件：适配器要认出这张表').not.toBeNull();
  return { descriptor: descriptor! } as never;
};

const rescan = async () => {
  const descriptor = readApplyForm('greenhouse', document);
  return descriptor === null ? null : ({ descriptor } as never);
};

const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Sample-Resume.pdf', { type: 'application/pdf' });

/** 宿主自己改值：只动 value 属性、不发事件（受控框架重渲染的样子）。 */
function hostSets(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
}

/** 用户在键盘上改了这一栏：浏览器标 isTrusted 的 input。 */
function personTypes(element: HTMLInputElement, value: string): void {
  hostSets(element, value);
  const event = new Event('input', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  element.dispatchEvent(event);
}

interface ParsingHost {
  readonly firstName: HTMLInputElement;
  readonly email: HTMLInputElement;
  readonly company: HTMLInputElement;
  readonly resume: HTMLInputElement;
  /** 我们每写一次文本栏，写入器发一次 change：数它就知道重写了几次。 */
  readonly writes: (element: HTMLInputElement) => number;
}

/**
 * Greenhouse 形状的申请表（合成）。`parse`：
 *  · 'once'   附上简历后 `delayMs` 改写姓名、清空邮箱、填上公司；
 *  · 'fights' 同上，而且我们重写邮箱之后它再清空一次；
 *  · 'never'  不解析（Greenhouse 那样）；
 *  · 'busy'   附上简历后一直在动（每 50 毫秒改一次状态字），并在 `delayMs` 改写姓名。
 */
function mountParsingHost(parse: 'once' | 'fights' | 'never' | 'busy', delayMs = 150): ParsingHost {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" required />
      <label for="email">Email</label><input id="email" type="email" required />
      <label for="company">Current Company</label><input id="company" type="text" required />
      <div class="field">
        <label for="resume">Resume/CV</label>
        <div>
          <input id="resume" type="file" accept=".pdf" required />
          <button type="button" class="attach">Attach</button>
          <span class="upload-status"></span>
        </div>
      </div>
    </form>`;
  vi.spyOn(document.querySelector<HTMLButtonElement>('button.attach')!, 'getBoundingClientRect').mockReturnValue(
    { width: 96, height: 36, top: 300, left: 40, right: 136, bottom: 336, x: 40, y: 300, toJSON: () => ({}) } as DOMRect,
  );
  const firstName = document.getElementById('first_name') as HTMLInputElement;
  const email = document.getElementById('email') as HTMLInputElement;
  const company = document.getElementById('company') as HTMLInputElement;
  const resume = document.getElementById('resume') as HTMLInputElement;
  const status = document.querySelector('.upload-status')!;
  const counts = new Map<Element, number>();
  for (const element of [firstName, email]) {
    element.addEventListener('change', () => { counts.set(element, (counts.get(element) ?? 0) + 1); });
  }
  const applyParse = () => {
    hostSets(firstName, 'SAMPLE FROM RESUME');
    hostSets(email, '');
    hostSets(company, 'Example Parsed Co');
    status.textContent = 'Parsed';
  };
  resume.addEventListener('change', () => {
    status.textContent = 'Parsing';
    if (parse === 'never') {
      status.textContent = 'Uploaded';
      return;
    }
    if (parse === 'busy') {
      let tick = 0;
      intervals.push(setInterval(() => { tick += 1; status.textContent = `Parsing ${tick}`; }, 50));
      setTimeout(() => hostSets(firstName, 'SAMPLE FROM RESUME'), delayMs);
      return;
    }
    setTimeout(applyParse, delayMs);
  });
  if (parse === 'fights') {
    // 我们第二次写邮箱（第二遍的重写）之后，宿主又把它清空一次。
    email.addEventListener('change', () => {
      if (counts.get(email) === 2) setTimeout(() => hostSets(email, ''), 40);
    });
  }
  return { firstName, email, company, resume, writes: (element) => counts.get(element) ?? 0 };
}

const PROFILE = { firstName: 'Sample', email: 'sample.person@example.test' } as never;

function collect() {
  const audits: KernelFillAudit[] = [];
  return { onAudit: (audit: KernelFillAudit) => { audits.push(audit); }, audit: () => audits[0]! };
}

const rowsOf = (view: AuditView) => view.rows.map((row) => [row.label, row.status, row.reason]);

async function fill(host: ParsingHost, over: Record<string, unknown> = {}) {
  const collected = collect();
  const resolve = vi.fn(async () => pdf());
  const result = await fillFromGesture({
    proof: trustedGesture(),
    scan: scanNow(),
    policy: livePolicy(),
    profile: PROFILE,
    resume: { fileName: 'Sample-Resume.pdf', targetVerified: true, resolve },
    rowAdds: { rescan, settleMs: 0 },
    hostSettle: { quietMs: 300, capMs: 3_000 },
    progress: { onOutcome: () => {}, shouldStop: () => false } as never,
    onAudit: collected.onAudit,
    ...over,
  } as never);
  expect(host.resume.files?.[0]?.name, '前置条件：简历挂上了').toBe('Sample-Resume.pdf');
  return { result, audit: collected.audit(), resolve };
}

describe('宿主在附上简历之后自己解析、改写别的栏', () => {
  // 150 毫秒：解析落在第一遍收尾那 250 毫秒里（第一遍自己就判了 LATE_REVERTED）；
  // 450 毫秒：落在第一遍结束之后、等宿主安静的这一段里（等完那一次复核才判）。两条路都要重写。
  it.each([150, 450])('我们写的栏被改写／清空 → 第二遍以资料为准重写一次；我们没写、宿主填上的 → 留着，照实说是网站从简历里读的（解析在附上后 %i 毫秒）', async (delayMs) => {
    const host = mountParsingHost('once', delayMs);
    const { result, audit, resolve } = await fill(host);

    expect(host.firstName.value).toBe('Sample');
    expect(host.email.value).toBe('sample.person@example.test');
    expect(host.company.value, '宿主从简历里读出来的值留着').toBe('Example Parsed Co');
    // 各重写一次：第一遍一次，第二遍一次，不循环。
    expect(host.writes(host.firstName)).toBe(2);
    expect(host.writes(host.email)).toBe(2);
    expect(resolve, '简历字节只取一次').toHaveBeenCalledTimes(1);

    expect(audit.settle?.outcome).toBe('QUIET');
    expect(rowsOf(audit.view)).toEqual([
      ['First Name', 'FILLED', null],
      ['Email', 'FILLED', null],
      ['Current Company', 'PREFILLED', 'NOT_EMPTY'],
      ['Resume/CV', 'FILLED', null],
    ]);
    expect(audit.view.rows.find((row) => row.label === 'Current Company')?.siteFilled).toBe('FROM_RESUME');
    expect(audit.view).toMatchObject({ requiredTotal: 4, requiredHandled: 4, needsAttention: 0 });
    // 复核说的也是同一张单子。
    expect(rowsOf(audit.recheck())).toEqual(rowsOf(audit.view));

    // 浮层：公司那一行不是「需要你」，照实写来源，不记成用户补上的。
    const dockRows = dockProgressFromAudit('run-parse', audit.view).rows.map((row, index) => toDockRow(row, index));
    const company = dockRows.find((row) => row.q === 'Current Company')!;
    expect(company).toMatchObject({ st: 'ok', fromResume: true, preserved: true });
    expect(dockRows.filter(isNeed)).toEqual([]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.map((outcome) => [outcome.key, outcome.ok])).toEqual([
      ['firstName', true],
      ['email', true],
      ['resumeFile', true],
    ]);
  });

  it('重写之后宿主又改掉：不再重写（不循环），照实报 LATE_REVERTED', async () => {
    const host = mountParsingHost('fights');
    const { result, audit } = await fill(host);

    expect(host.email.value).toBe('');
    expect(host.writes(host.email), '只重写一次').toBe(2);
    expect(audit.view.rows.find((row) => row.label === 'Email')).toMatchObject({ status: 'FAILED', reason: 'LATE_REVERTED' });
    expect(audit.view.rows.find((row) => row.label === 'First Name')).toMatchObject({ status: 'FILLED' });
    expect(result.ok && result.outcomes.find((outcome) => outcome.key === 'email')).toMatchObject({ ok: false, reason: 'LATE_REVERTED' });
  });

  it('开写之前就已经有值的栏：后来还有值，也不算成网站从简历里读的', async () => {
    const host = mountParsingHost('once');
    // 一道我们认不出键的开放题，用户在点自动填写之前就自己答了。
    host.company.insertAdjacentHTML(
      'afterend',
      '<label for="why">Why do you want to work here?</label><textarea id="why" required>Because of the team.</textarea>',
    );
    const { audit } = await fill(host);

    const why = audit.view.rows.find((row) => row.label === 'Why do you want to work here?');
    expect(why?.siteFilled, '用户自己早先答的，被记成了网站从简历里读的').toBeUndefined();
    expect(audit.view.rows.find((row) => row.label === 'Current Company')?.siteFilled).toBe('FROM_RESUME');
  });

  it('用户在等待期间亲手改的栏：不重写，也不算成网站填的', async () => {
    const host = mountParsingHost('once');
    // 解析回来之后、我们重写之前，用户自己改了姓名、在公司栏里敲了字。
    host.resume.addEventListener('change', () => {
      setTimeout(() => {
        personTypes(host.firstName, 'Sam');
        personTypes(host.company, 'Typed Co');
      }, 220);
    });
    const { audit } = await fill(host);

    expect(host.firstName.value, '用户改过的姓名被覆盖了').toBe('Sam');
    expect(host.writes(host.firstName)).toBe(1);
    expect(host.email.value, '用户没碰的邮箱照常重写').toBe('sample.person@example.test');
    expect(host.company.value).toBe('Typed Co');
    const company = audit.view.rows.find((row) => row.label === 'Current Company');
    expect(company?.siteFilled, '用户敲的字不能记成网站填的').toBeUndefined();
    expect(company?.status).toBe('MISSING_PROFILE');
  });
});

describe('等多久', () => {
  it('不解析的宿主（Greenhouse 那样）：只多等一个安静窗口，不重写任何一栏', async () => {
    const host = mountParsingHost('never');
    // 生产上的窗口（600 毫秒、最多 4 秒），量一下真实的额外延迟。
    const { audit } = await fill(host, { hostSettle: undefined });

    expect(audit.settle?.outcome).toBe('QUIET');
    expect(audit.settle!.waitedMs).toBeGreaterThanOrEqual(600);
    expect(audit.settle!.waitedMs, '不解析的页面多等的不该超出安静窗口太多').toBeLessThan(1_000);
    expect(host.writes(host.firstName)).toBe(1);
    expect(host.writes(host.email)).toBe(1);
    expect(rowsOf(audit.view)).toEqual([
      ['First Name', 'FILLED', null],
      ['Email', 'FILLED', null],
      ['Current Company', 'MISSING_PROFILE', 'NO_VALUE'],
      ['Resume/CV', 'FILLED', null],
    ]);
  });

  it('宿主一直在动：等到上限就停，不无限等', async () => {
    const host = mountParsingHost('busy', 5_000);
    const { audit } = await fill(host, { hostSettle: { quietMs: 300, capMs: 900 } });

    expect(audit.settle?.outcome).toBe('CAPPED');
    expect(audit.settle!.waitedMs).toBeGreaterThanOrEqual(900);
    expect(audit.settle!.waitedMs).toBeLessThan(1_500);
  });

  it('按停止：等待立刻结束，第二遍不跑，不重写', async () => {
    const host = mountParsingHost('busy', 200);
    let stop = false;
    // 第一遍在附上简历之后还有约 250 毫秒的收尾；停止落在那之后、等宿主安静的这一段里。
    host.resume.addEventListener('change', () => { setTimeout(() => { stop = true; }, 450); });
    const { audit } = await fill(host, {
      hostSettle: { quietMs: 300, capMs: 3_000 },
      progress: { onOutcome: () => {}, shouldStop: () => stop } as never,
    });

    expect(audit.settle?.outcome).toBe('ABORTED');
    expect(audit.settle!.waitedMs, '停止之后还在等').toBeLessThan(1_000);
    expect(host.firstName.value, '按了停止还在重写').toBe('SAMPLE FROM RESUME');
    expect(host.writes(host.firstName)).toBe(1);
    // 如实：被宿主改掉的那一栏不再说「已填」。
    expect(audit.view.rows.find((row) => row.label === 'First Name')).toMatchObject({ status: 'FAILED', reason: 'LATE_REVERTED' });
  });

  it('页面换代（外部 abort）：等待立刻结束', async () => {
    const host = mountParsingHost('busy', 5_000);
    const controller = new AbortController();
    host.resume.addEventListener('change', () => { setTimeout(() => controller.abort(), 450); });
    const { audit } = await fill(host, { signal: controller.signal });

    expect(audit.settle?.outcome).toBe('ABORTED');
    expect(audit.settle!.waitedMs).toBeLessThan(1_000);
  });
});
