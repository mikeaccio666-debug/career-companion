// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FULL_AI_JOB_LIMITS, type FullAiField, type FullAiJob, type FullAiRequest } from '@edaix/contracts';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { readApplyForm } from '@edaix/apply-kernel/registry';
import { createAiAnswersSession, createAiStreamReceiver, type AiAnswersSink, type KernelAiAnswersPort } from '../lib/aiAnswers';
import { createAiAnswersClient } from '../lib/aiAnswersClient';
import { createDockAiAnswersIntent, parseDockAiAnswersIntent } from '../lib/aiAnswersIntent';
import { createAiAnswersProvider } from '../lib/aiAnswersProvider';
import { fillFromGesture } from '../lib/gestureFill';
import { createNearbyPostingReader } from '../lib/jobCardFromPage';
import type { KernelFillAudit } from '../lib/kernelFiller';

installBundledApplyAdapters();

/**
 * 「AI 代答」一次点击、一条流的整条路（2026-09-24，argoland #620 的 `plan/stream`）：假的 NDJSON 服务端 → worker 的
 * 客户端与 provider → 长连接上的消息（按结构化克隆过一遍）→ 内容脚本的接收器 → 会话 → 内核写进页面。
 *
 *  · 选择题那一行一到就写上，开放题那一行服务端还没发；
 *  · 一次点击只打一次 `plan/stream`；
 *  · 一行不合格就不再读：已经写上的留着，其余当没答上；
 *  · 岗位 `job` 从页面的 JobPosting 读、截到契约上限、去掉控制字符，随请求上行。
 *
 * 夹具全是合成文字，没有任何真实用户资料。
 */

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

function trustedProof() {
  const host = document.createElement('div');
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let proof: ReturnType<typeof captureTrustedShadowGesture> = null;
  button.addEventListener('click', (clicked) => { proof = captureTrustedShadowGesture(clicked, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click'));
  expect(proof, '前置条件：凭证要取得到').not.toBeNull();
  return proof!;
}

function livePolicy(): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return { ...base, notAfter: Date.now() + 10 * 60_000 };
}

function mountForm(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" required />
      <label for="why">Why do you want to work here?</label><textarea id="why" required maxlength="400"></textarea>
      <label for="kotlin_years">How many years of Kotlin experience do you have?</label><input id="kotlin_years" type="text" />
      <fieldset id="kotlin-question"><legend>Do you have experience with Kotlin?</legend>
        <label><input name="kotlin" type="radio" value="0" /> Yes</label>
        <label><input name="kotlin" type="radio" value="1" /> No</label>
      </fieldset>
    </form>`;
}

const PAGE = ['https://job-boards.greenhouse.io', '/acme/jobs/1'] as const;
const WHY = 'I want to build payment tools, which is what I did at my last job.';
const value = (id: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!.value;
const checked = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.parentElement?.textContent?.trim() ?? null;
const encoder = new TextEncoder();

/** 假的服务端：每一行由测试决定什么时候写出去；记下收到的请求。 */
function fakeServer() {
  const requests: FullAiRequest[] = [];
  let push: (line: unknown) => void = () => {};
  let finish: () => void = () => {};
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as FullAiRequest);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) => controller.enqueue(encoder.encode(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`));
        finish = () => controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  });
  const request = () => requests[0]!;
  const idOf = (label: string) => request().fields.find((field) => field.label === label)!.id;
  const answers = (lane: 'fast' | 'long', instructions: unknown[]) => ({
    schemaVersion: 1, type: 'answers', requestId: request().requestId, snapshotId: request().snapshotId, lane,
    profileRevision: '3', deletionEpoch: '0', expiresAt: '2026-09-24T12:00:00.000Z', instructions,
  });
  const fill = (label: string, extra: Record<string, unknown>) => ({
    id: idOf(label), action: 'fill', value: null, optionIds: [], sourcePaths: ['skills.0.name'], confidence: 0.95, reason: 'PROFILE', ...extra,
  });
  const done = (unanswered: { code: string; fieldIds: string[] }[] = []) => ({
    schemaVersion: 1, type: 'done', ok: true, requestId: request().requestId, unanswered,
    metrics: { planningMs: 5_000, fieldCount: request().fields.length, modelCalls: 2, fastMs: 2_000, longMs: 5_000, model: 'test' },
  });
  return {
    fetchFn,
    requests,
    push: (line: unknown) => push(line),
    finish: () => finish(),
    fastLine: () => answers('fast', [
      fill('Do you have experience with Kotlin?', { optionIds: ['o0'] }),
      fill('How many years of Kotlin experience do you have?', { value: '5' }),
    ]),
    longLine: () => answers('long', [fill('Why do you want to work here?', { value: WHY, reason: 'DRAFT', sourcePaths: ['summary'] })]),
    done,
    idOf,
  };
}

/**
 * worker 与内容脚本之间那条长连接的替身：内容脚本这一头用真的接收器，worker 那一头用真的 provider；
 * 消息像扩展消息那样过一遍结构化克隆。
 */
function streamPort(server: ReturnType<typeof fakeServer>, job?: FullAiJob): KernelAiAnswersPort {
  const provider = createAiAnswersProvider({
    client: createAiAnswersClient({ apiBase: 'https://api.argoland.ai', getAccessToken: async () => 'tok', fetchFn: server.fetchFn as never }),
    storage: { get: async () => undefined, set: async () => undefined },
    userId: async () => 'user-1',
  });
  return {
    request: (fields: readonly FullAiField[], sink: AiAnswersSink) => {
      const receiver = createAiStreamReceiver(fields, sink);
      const gone = new AbortController();
      const intent = parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, {
        step: 'PLAN', title: 'Analyst at Acme', fields, ...(job === undefined ? {} : { job }),
      }));
      expect(intent, '前置条件：意图要过得了 worker 的解析').not.toBeNull();
      void provider.stream(intent!, (message) => receiver.message(structuredClone(message)), gone.signal).finally(() => receiver.cut());
      return () => { receiver.close(); gone.abort(); };
    },
  };
}

async function click(port: KernelAiAnswersPort) {
  const audits: KernelFillAudit[] = [];
  const proof = trustedProof();
  const session = createAiAnswersSession({ port, gesture: proof });
  const result = await fillFromGesture({
    proof,
    scan: { descriptor: readApplyForm('greenhouse', document)! } as never,
    policy: livePolicy(),
    profile: { firstName: 'Sample' } as never,
    progress: { onOutcome: () => {}, shouldStop: () => false } as never,
    onAudit: (audit: KernelFillAudit) => audits.push(audit),
    onPlanned: session.onPlanned,
  } as never);
  expect(result.ok).toBe(true);
  return session.attach(audits[0]!)!;
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  expect(check()).toBe(true);
}

describe('一次点击、一条流：选择题先到先写', () => {
  it('选择题那一行一到就写进页面，服务端还没发开放题；开放题那一行到了再写；整轮只打一次 plan/stream', async () => {
    mountForm();
    const server = fakeServer();
    const ai = await click(streamPort(server));
    await until(() => server.requests.length === 1);
    expect(server.fetchFn).toHaveBeenCalledTimes(1);
    expect((server.fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('https://api.argoland.ai/api/v1/agent/full-ai-autofill/plan/stream');

    server.push(server.fastLine());
    await until(() => checked('kotlin') === 'Yes' && value('kotlin_years') === '5');
    // 开放题那一行服务端还没发：那一栏空着。
    expect(value('why')).toBe('');

    server.push(server.longLine());
    server.push(server.done());
    server.finish();
    const outcome = await ai.outcome;
    expect(outcome).toMatchObject({ kind: 'APPLIED', written: 3, unanswered: [] });
    expect(value('why')).toBe(WHY);
    expect(server.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('一行不合格就不再读：已经写上的留着，后面到的一个字不写，没拿到答案的题交回来', async () => {
    mountForm();
    const server = fakeServer();
    const ai = await click(streamPort(server));
    await until(() => server.requests.length === 1);
    server.push(server.fastLine());
    server.push('{"schemaVersion":1,"type":"answers","injected":"<script>"}');
    server.push(server.longLine());
    server.push(server.done());
    server.finish();
    const outcome = await ai.outcome;
    expect(outcome).toMatchObject({ kind: 'APPLIED', written: 2, unanswered: [document.querySelector('#why')] });
    expect(checked('kotlin')).toBe('Yes');
    expect(value('why')).toBe('');
  });

  it('服务端交代某一题那一道失败了：别的照写，那一题交回来', async () => {
    mountForm();
    const server = fakeServer();
    const ai = await click(streamPort(server));
    await until(() => server.requests.length === 1);
    server.push(server.fastLine());
    server.push(server.done([{ code: 'FULL_AI_PROVIDER_FAILED', fieldIds: [server.idOf('Why do you want to work here?')] }]));
    server.finish();
    expect(await ai.outcome).toMatchObject({ kind: 'APPLIED', written: 2, unanswered: [document.querySelector('#why')] });
  });
});

describe('岗位 job 随请求上行', () => {
  it('从页面的 JobPosting 读、截到契约上限、去掉控制字符；读不出的一项不带', async () => {
    mountForm();
    const long = `${'Build Playwright suites for our checkout. '.repeat(400)}\u0007end`;
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: `QA Engineer ${'x'.repeat(400)}`,
      hiringOrganization: { '@type': 'Organization', name: 'Acme\u0000 Learning' },
      description: `<p>About Acme</p><p>${long}</p>`,
    });
    document.head.append(script);
    const job = await createNearbyPostingReader({ fetch: vi.fn() as never }).job(document, 'https://job-boards.greenhouse.io/acme/jobs/1');
    expect(job).toBeDefined();
    expect(job!.title!.length).toBeLessThanOrEqual(FULL_AI_JOB_LIMITS.title);
    expect(job!.company).toBe('Acme Learning');
    expect(job!.location).toBeUndefined();
    expect(job!.description!.length).toBeLessThanOrEqual(FULL_AI_JOB_LIMITS.description);
    expect(job!.description!.startsWith('About Acme\nBuild Playwright suites')).toBe(true);
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(JSON.stringify(Object.values(job!)))).toBe(false);

    const server = fakeServer();
    const ai = await click(streamPort(server, job));
    await until(() => server.requests.length === 1);
    expect(server.requests[0]!.job).toEqual(job);
    server.push(server.done([{ code: 'FULL_AI_PROVIDER_FAILED', fieldIds: server.requests[0]!.fields.map((field) => field.id) }]));
    server.finish();
    // 服务端交代三道都没答上：一个字不写，三栏的原因照实说。
    const outcome = await ai.outcome;
    expect(outcome.kind).toBe('NONE');
    expect(outcome.kind === 'NONE' && outcome.unanswered).toHaveLength(3);
  });

  it('页面上没有 JobPosting：不带 job', async () => {
    mountForm();
    expect(await createNearbyPostingReader({ fetch: vi.fn() as never }).job(document, 'https://job-boards.greenhouse.io/acme/jobs/1')).toBeUndefined();
  });
});
