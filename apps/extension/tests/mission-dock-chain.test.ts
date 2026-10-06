// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { captureTrustedShadowGesture } from '@edaix/apply-kernel/grant';
import { createBundledApplyPolicy, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import { readApplyForm } from '@edaix/apply-kernel/registry';
import {
  MISSION_MATERIAL_HEADERS,
  parseEnsureMissionStartApprovalRequestV1,
  parseReleaseMissionCoverLetterRequestV1,
  parseReleaseMissionResumeRequestV1,
  parseRequestMissionCoverLetterRequestV1,
  parseResolveMissionPageBindingRequestV1,
} from '@edaix/contracts';

import { sha256CanonicalJson } from '../lib/canonicalDigest';
import { coverLetterDemand, createDockMissionSession } from '../lib/dockMissionContent';
import { createDockMissionCoverLetterIntent, createDockSubmitConfirmedIntent } from '../lib/dockMissionIntent';
import { createDockMissionRuns } from '../lib/dockMissionRuns';
import { createDockMissionWorker, createTabMissionBindings } from '../lib/dockMissionWorker';
import { fillFromGesture } from '../lib/gestureFill';
import { createIntentClient } from '../lib/intentClient';
import { createMissionDockClient } from '../lib/missionDockClient';
import { createMissionMaterialsClient } from '../lib/missionMaterialsClient';
import { createMissionPageBindingClient } from '../lib/missionPageBindingClient';
import { uploadDockReceipt } from '../lib/receiptClient';
import { createResumeAttachmentClient } from '../lib/resumeAttachmentClient';
import {
  createDockResumeAttachmentIntent,
  parseDockResumeAttachmentIntent,
  parseDockResumeAttachmentReply,
} from '../lib/resumeAttachmentIntent';
import { createResumeAttachmentProvider } from '../lib/resumeAttachmentProvider';
import { resumeSeamFromWorker } from '../lib/resumeSeam';
import { senderTabForPageOrFrame } from '../lib/senderPage';
import { createSubmitController } from '../lib/submitController';
import { createTestIntentSigner, type TestIntentSigner } from './helpers/intentSigner';
import { baseClaims, FIXTURE_HEADER, sha } from './helpers/intentFixtures';

/**
 * 浮层任务接线，整条链（2026-09-24，argoland「开始申请即批准」）。
 *
 * 用户在门户按了「开始申请」，打开那个岗位的申请页，在浮层里按自动填写、再按提交。这里把插件这一侧
 * 真的模块全接起来——worker 的页面归属、运行记录、材料入口、简历供给、回执、提交回报，内容脚本的
 * 任务会话、手势填写与浮层提交——只把网络换成一个照 argoland 契约夹具作答的假后端，钉住：
 *
 *  1. 绑着任务的页：先记「开始申请」的批准（扫到的规范键），再签发、claim（同一组键），填完交回执；
 *  2. 简历与求职信只从任务的材料入口来，从不问手势路那条「为这个岗位准备过的一版」；
 *  3. 用户在浮层按「提交」、网站确认之后，报一条 USER_REPORTED_SUBMISSION；
 *  4. 任务那一侧的任何失败都不挡填写；
 *  5. 没绑任务的页：手势路原样，一条任务请求都不发。
 *
 * 夹具是契约包里那一份（packages/contracts/tests/fixtures/mission-wiring），argoland 那边的
 * Postgres 整链测试产出的是同一个形状。
 */

installBundledApplyAdapters();

const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(
  resolve(__dirname, '..', '..', '..', 'packages', 'contracts', 'tests', 'fixtures', 'mission-wiring', `${name}.json`),
  'utf8',
)) as T;

const API = 'https://api.test.invalid';
const EXTENSION_ID = 'argoland-extension-test';
const TAB_ID = 7;
const USER_ID = '00000000-0000-4000-8000-00000000a0aa';
const INSTALL_ID = '00000000-0000-4000-8000-00000000a007';
const BINDING = fixture<{ binding: Record<string, never> }>('page-binding-response').binding as unknown as {
  missionId: string;
  missionRevision: string;
  target: { canonicalOrigin: string; pathname: string };
  application: { applicationId: string; applicationBundleVersion: string };
};
const MISSION_ID = BINDING.missionId;
const PAGE = Object.freeze({ origin: BINDING.target.canonicalOrigin, pathname: BINDING.target.pathname });
/** The page as the tab has it: the job link carries a tracking tail the worker ignores. */
const SENDER = Object.freeze({
  id: EXTENSION_ID,
  frameId: 0,
  tab: { id: TAB_ID },
  url: `${PAGE.origin}${PAGE.pathname}?gh_src=chain`,
});
/** A synthetic PDF: only its digest and size matter to the release. */
const RESUME_BYTES = new TextEncoder().encode(`%PDF-1.4\n${'chain fixture resume\n'.repeat(96)}%%EOF\n`);
const COVER_LETTER_TEXT = fixture<{ text: string }>('cover-letter-text').text;
const PROFILE = { firstName: 'Avery', lastName: 'ChainTest', email: 'avery@example.test' } as never;

let signer: TestIntentSigner;
beforeAll(async () => {
  signer = await createTestIntentSigner();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

type Call = Readonly<{ method: string; path: string; body: unknown }>;
type FakeResponse = Readonly<{
  ok: boolean;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  json: () => Promise<unknown>;
}>;

const json = (status: number, body: unknown): FakeResponse => ({
  ok: status < 400,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: null,
  json: async () => body,
});

const pdf = (bytes: Uint8Array, headers: Record<string, string>): FakeResponse => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'application/pdf', 'content-length': String(bytes.byteLength), ...headers }),
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }),
  json: async () => { throw new SyntaxError('not json'); },
});

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * argoland as the contract fixtures describe it: one Mission bound to one application page,
 * a Start approval over the scanned keys the runtime allows, the ordinary intent and claim,
 * the materials entry, the receipt and the submission event.
 */
function fakeArgoland(options: Readonly<{
  bound?: boolean;
  issueStatus?: number;
  resume?: 'READY' | 'UNAVAILABLE';
}> = {}) {
  const calls: Call[] = [];
  const state: {
    approvedKeys: readonly string[];
    executionStepId: string;
    scanDigestSeen: string | null;
    expectedScanDigest: string | null;
  } = {
    approvedKeys: [],
    executionStepId: '00000000-0000-4000-8000-00000000a0e1',
    scanDigestSeen: null,
    expectedScanDigest: null,
  };
  const startApproval = fixture<Record<string, unknown> & { approval: Record<string, unknown> }>('start-approval-response');
  const materials = fixture<Record<string, unknown>>(options.resume === 'UNAVAILABLE' ? 'materials-resume-unavailable' : 'materials');
  const materialsResume = materials['resume'] as Record<string, unknown>;
  if (materialsResume['state'] === 'READY') materialsResume['size'] = RESUME_BYTES.byteLength;

  const route = async (method: string, path: string, body: unknown): Promise<FakeResponse> => {
    const mission = `/api/v1/agent/missions/${MISSION_ID}`;
    if (method === 'POST' && path === '/api/v1/agent/missions/page-binding') {
      const request = parseResolveMissionPageBindingRequestV1(body);
      if (request === null) return json(400, { code: 'VALIDATION_FAILED' });
      const same = request.canonicalOrigin === PAGE.origin && request.pathname === PAGE.pathname;
      return json(200, fixture(options.bound === false || !same ? 'page-binding-none' : 'page-binding-response'));
    }
    if (method === 'POST' && path === `${mission}/start-approvals`) {
      const request = parseEnsureMissionStartApprovalRequestV1(body);
      if (request === null) return json(400, { code: 'VALIDATION_FAILED' });
      if (request.extensionInstallId !== INSTALL_ID) return json(403, { code: 'EXTENSION_INSTALL_MISMATCH' });
      // What the runtime policy allows on this page: the approval is the intersection.
      state.approvedKeys = request.fieldKeys.filter((key) => key !== 'phone');
      return json(201, { ...startApproval, approval: { ...startApproval.approval, fieldKeys: state.approvedKeys } });
    }
    if (method === 'POST' && path === `${mission}/execution-intents`) {
      if ((options.issueStatus ?? 201) !== 201) return json(options.issueStatus ?? 409, { code: 'MISSION_REVISION_CONFLICT' });
      const now = Math.floor(Date.now() / 1000);
      const claims = baseClaims({
        sub: USER_ID,
        iss: API,
        iat: now - 5,
        nbf: now - 5,
        exp: now + 100,
        missionId: MISSION_ID,
        missionRevision: '3',
        missionStepId: state.executionStepId,
        extensionInstallId: INSTALL_ID,
        target: { ...(baseClaims()['target'] as object), canonicalOrigin: PAGE.origin },
        fieldKeys: [...state.approvedKeys],
        planDigest: sha('b'),
      });
      state.expectedScanDigest = await sha256CanonicalJson({
        schemaVersion: 1,
        canonicalOrigin: PAGE.origin,
        pathname: PAGE.pathname,
        vendor: 'greenhouse',
        fieldKeys: [...state.approvedKeys],
      });
      return json(201, {
        schemaVersion: 1,
        executionIntent: await signer.sign(FIXTURE_HEADER, { ...claims, iss: API }),
        expiresAt: new Date((now + 100) * 1000).toISOString(),
        intentVersion: 1,
        kid: FIXTURE_HEADER.kid,
      });
    }
    if (method === 'GET' && path === '/.well-known/edaix-execution-intent-jwks.json') {
      return json(200, { keys: [signer.publicJwk, signer.decoyJwk] });
    }
    if (method === 'POST' && path === '/api/v1/agent/execution-intents/claim') {
      const request = body as { actualFieldKeys: string[]; scanDigest: string; extensionInstallId: string };
      state.scanDigestSeen = request.scanDigest;
      if (JSON.stringify([...request.actualFieldKeys].sort()) !== JSON.stringify(state.approvedKeys)) {
        return json(409, { code: 'EXECUTION_FIELD_SET_MISMATCH' });
      }
      if (request.scanDigest !== state.expectedScanDigest) return json(409, { code: 'EXECUTION_PLAN_MISMATCH' });
      return json(200, {
        schemaVersion: 1,
        claim: {
          missionId: MISSION_ID,
          missionStepId: state.executionStepId,
          intentVersion: 1,
          executionLease: 'opaque-lease-chain',
          leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          allowedActions: ['FILL'],
        },
      });
    }
    if (method === 'POST' && path === `${mission}/receipts`) return json(201, { schemaVersion: 1 });
    if (method === 'GET' && path === `${mission}/materials`) return json(200, materials);
    if (method === 'POST' && path === `${mission}/materials/resume`) {
      if (parseReleaseMissionResumeRequestV1(body) === null) return json(400, { code: 'VALIDATION_FAILED' });
      return pdf(RESUME_BYTES, {
        [MISSION_MATERIAL_HEADERS.sha256]: `sha256:${await sha256Hex(RESUME_BYTES)}`,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(String(materialsResume['fileName']))}`,
      });
    }
    if (method === 'POST' && path === `${mission}/materials/cover-letter`) {
      if (parseRequestMissionCoverLetterRequestV1(body) === null) return json(400, { code: 'VALIDATION_FAILED' });
      return json(200, fixture('cover-letter-result'));
    }
    if (method === 'POST' && path === `${mission}/materials/cover-letter/text`) {
      if (parseReleaseMissionCoverLetterRequestV1(body) === null) return json(400, { code: 'VALIDATION_FAILED' });
      return json(200, fixture('cover-letter-text'));
    }
    if (method === 'GET' && path === mission) {
      return json(200, {
        schemaVersion: 1,
        mission: {
          id: MISSION_ID,
          status: 'WAITING_FOR_USER',
          application: {
            applicationId: BINDING.application.applicationId,
            applicationBundleVersion: BINDING.application.applicationBundleVersion,
            applicationRevision: '4',
            submissionState: 'ELIGIBLE',
          },
        },
      });
    }
    if (method === 'POST' && path === `${mission}/submission-events`) return json(201, { schemaVersion: 1 });
    return json(404, { code: 'NOT_FOUND' });
  };

  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path: url.pathname, body });
    return route(method, url.pathname, body);
  }) as unknown as typeof fetch;

  return {
    calls,
    state,
    fetchFn,
    paths: () => calls.map((call) => `${call.method} ${call.path.replace(MISSION_ID, ':id')}`),
    bodyOf: (method: string, suffix: string) => calls.find((call) => call.method === method && call.path.endsWith(suffix))?.body,
  };
}

/** The worker, wired as `entrypoints/background.ts` wires it, over one fake backend. */
function worker(server: ReturnType<typeof fakeArgoland>) {
  const diagnostics: string[] = [];
  const onDiagnostic = (code: string) => { diagnostics.push(code); };
  const auth = {
    apiBase: API,
    getAccessToken: async () => 'token-chain',
    refreshAccessToken: async () => 'token-chain-2',
    fetchFn: server.fetchFn,
  };
  const intentClient = createIntentClient({
    ...auth,
    expectedIssuer: API,
    getUserId: async () => USER_ID,
    getInstallId: async () => INSTALL_ID,
    onDiagnostic,
  });
  const bindings = createTabMissionBindings({ client: createMissionPageBindingClient(auth) });
  const missionDock = createMissionDockClient({ ...auth, getInstallId: async () => INSTALL_ID });
  const runs = createDockMissionRuns({
    bindingFor: (tabId, page) => bindings.fresh(tabId, page),
    missions: missionDock,
    acquirer: intentClient.acquirer,
    claimer: intentClient.claimer,
    uploadReceipt: (input) => uploadDockReceipt({ ...auth, onDiagnostic }, input),
    onDiagnostic,
  });
  const mission = createDockMissionWorker({
    extensionId: EXTENSION_ID,
    readFrameForms: async () => ({}),
    bindings,
    runs,
    materials: createMissionMaterialsClient(auth),
    missions: missionDock,
    onDiagnostic,
  });
  const resumeProvider = createResumeAttachmentProvider({
    // The gesture path's own library read: a bound page must never reach it.
    listResumes: async () => ({ ok: false, code: 'UNAVAILABLE' }) as never,
    client: createResumeAttachmentClient(auth),
    missionResume: async (senderKey, page) => {
      const tabId = Number(senderKey);
      return Number.isSafeInteger(tabId)
        ? mission.resumeSupply(tabId, { canonicalOrigin: page.origin, pathname: page.pathname })
        : null;
    },
    onDiagnostic,
  });
  /** `browser.runtime.sendMessage` from the page's own top frame, routed as the worker routes it. */
  const send = async (message: unknown): Promise<unknown> => {
    const resume = parseDockResumeAttachmentIntent(message);
    if (resume !== null) {
      const tabId = senderTabForPageOrFrame(SENDER, EXTENSION_ID, resume, {});
      return tabId === null ? undefined : resumeProvider.handle(resume, String(tabId));
    }
    return mission.handle(message, SENDER);
  };
  const hello = () => bindings.isBound(TAB_ID, { canonicalOrigin: PAGE.origin, pathname: PAGE.pathname });
  return { mission, send, hello, diagnostics };
}

/** Greenhouse's application form: names, an education row, a required résumé file and a letter box. */
function applicationPage(options: Readonly<{ letterRequired?: boolean }> = {}) {
  document.body.innerHTML = `
    <main>
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        <label for="last_name">Last Name</label><input id="last_name" type="text" />
        <label for="email">Email</label><input id="email" type="email" />
        <label for="phone">Phone</label><input id="phone" type="tel" />
        <div class="education--container">
          <div class="education--form">
            <label for="school--0">School</label><input id="school--0" type="text" />
          </div>
        </div>
        <div class="field">
          <label for="resume">Resume/CV</label>
          <div>
            <input id="resume" type="file" accept=".pdf,.doc,.docx" required />
            <button type="button">Attach</button>
          </div>
        </div>
        <label for="cover_letter_text">Cover Letter</label>
        <textarea id="cover_letter_text" name="cover_letter_text" ${options.letterRequired === false ? '' : 'required'}></textarea>
        <button id="submit_app" type="submit">Submit application</button>
      </form>
    </main>`;
  // happy-dom has no layout: the visible Attach trigger needs a real box.
  const attach = document.querySelector('button[type="button"]') as HTMLButtonElement;
  vi.spyOn(attach, 'getBoundingClientRect').mockReturnValue(
    { width: 96, height: 36, top: 0, left: 0, right: 96, bottom: 36, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  );
  // The site's own submit handler takes the application and says so.
  const siteSubmits = vi.fn((event: Event) => {
    event.preventDefault();
    document.querySelector('main')!.innerHTML = '<h1>Thank you for applying!</h1>';
  });
  document.getElementById('submit_app')!.addEventListener('click', siteSubmits);
  const descriptor = readApplyForm('greenhouse', document);
  expect(descriptor, 'precondition: the Greenhouse rules read this form').not.toBeNull();
  return { descriptor: descriptor!, siteSubmits };
}

const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value;

function livePolicy(capabilities: Partial<ApplyPolicy['capabilities']> = {}): ApplyPolicy {
  const base = createBundledApplyPolicy();
  return {
    ...base,
    enabled: true,
    vendors: { ...base.vendors, greenhouse: true },
    capabilities: { ...base.capabilities, ...capabilities },
    notAfter: Date.now() + 60_000,
  };
}

/** The user's click on our dock button: a trusted event from our own shadow root. */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
function clickInOurShadow<T>(run: (event: MouseEvent, shadowRoot: ShadowRoot) => T): T {
  const host = document.createElement('div');
  document.documentElement.append(host);
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  shadowRoot.append(button);
  let result: T | undefined;
  button.addEventListener('click', (event) => { result = run(event, shadowRoot); });
  button.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
  host.remove();
  return result as T;
}

/**
 * The content script's dock run (`runGestureFill` on a READY face): record the run, fetch
 * the letter the form insists on and the résumé, fill with the gesture engine, finish.
 */
async function dockRun(
  send: (message: unknown) => Promise<unknown>,
  descriptor: NonNullable<ReturnType<typeof readApplyForm>>,
  options: Readonly<{ missionBound: boolean; profile?: unknown }>,
) {
  const session = createDockMissionSession({ send, page: () => PAGE, wrap: (intent) => intent });
  const proof = clickInOurShadow((event, shadowRoot) => captureTrustedShadowGesture(event, shadowRoot));
  expect(proof, 'precondition: our own trusted click').not.toBeNull();
  const scanKeys = [...new Set(descriptor.fields.map((field) => field.key).filter((key): key is NonNullable<typeof key> => key !== null))];
  const ticket = options.missionBound ? session.begin({ fieldKeys: scanKeys, vendor: 'greenhouse' }) : null;
  const letter = options.missionBound && coverLetterDemand(descriptor) === 'REQUIRED'
    ? session.coverLetter('FORM_REQUIRED')
    : null;
  const askResume = async (step: 'PLAN' | 'RELEASE') => {
    const intent = createDockResumeAttachmentIntent(PAGE.origin, PAGE.pathname, step);
    return intent === null ? null : parseDockResumeAttachmentReply(await send(intent));
  };
  const [resume, , letterText] = await Promise.all([
    resumeSeamFromWorker(askResume),
    ticket ?? Promise.resolve(null),
    letter ?? Promise.resolve(null),
  ]);
  const result = await fillFromGesture({
    proof: proof as never,
    scan: { descriptor } as never,
    profile: (options.profile ?? PROFILE) as never,
    policy: livePolicy(),
    progress: { onOutcome: () => {}, shouldStop: () => false } as never,
    ...(resume === undefined ? {} : { resume }),
    ...(letterText === null ? {} : { coverLetter: { text: letterText } }),
  } as never);
  const finished = ticket === null ? Promise.resolve() : ticket.then((opened) => {
    if (opened !== null) session.finish(opened, result.ok ? result.outcomes : []);
  });
  await finished;
  return { session, result, ticket: ticket === null ? null : await ticket, scanKeys };
}

/** Wait for the fake backend to see a request (the finish and the report are fire-and-forget). */
async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

describe('A page bound to a Mission the user started in the portal', () => {
  it('records the dock run under the Start approval: approval → intent → claim → receipt, keys as scanned', async () => {
    const server = fakeArgoland();
    const { send, hello, diagnostics } = worker(server);
    const { descriptor } = applicationPage();

    await expect(hello(), 'the dock shows the READY face').resolves.toBe(true);
    const { result, ticket, scanKeys } = await dockRun(send, descriptor, { missionBound: true });
    // The finish is fire-and-forget from the page: wait for the worker to have filed it.
    await until(() => diagnostics.includes('DOCK_MISSION_RECEIPT_SENT'));

    expect(ticket).toMatch(/^[0-9a-f-]{36}$/);
    const runOrder = server.paths().filter((path) =>
      /start-approvals|execution-intents|receipts/.test(path));
    expect(runOrder).toEqual([
      'POST /api/v1/agent/missions/:id/start-approvals',
      'POST /api/v1/agent/missions/:id/execution-intents',
      'POST /api/v1/agent/execution-intents/claim',
      'POST /api/v1/agent/missions/:id/receipts',
    ]);

    // Start approval: exactly the canonical Profile keys the scan found (no row or file keys).
    const approval = parseEnsureMissionStartApprovalRequestV1(server.bodyOf('POST', '/start-approvals'));
    expect(approval).not.toBeNull();
    expect(scanKeys, 'precondition: the scan also found a row key').toContain('education.school');
    expect(approval!.fieldKeys).toEqual(['email', 'firstName', 'lastName', 'phone']);
    expect(approval).toMatchObject({
      expectedMissionRevision: BINDING.missionRevision,
      extensionInstallId: INSTALL_ID,
      page: { canonicalOrigin: PAGE.origin, pathname: PAGE.pathname },
    });

    // Claim: the approved keys (the runtime allowed one fewer), with the scan digest over them.
    expect(server.bodyOf('POST', '/execution-intents/claim')).toMatchObject({
      actualFieldKeys: ['email', 'firstName', 'lastName'],
      extensionInstallId: INSTALL_ID,
    });
    expect(server.state.scanDigestSeen).toBe(server.state.expectedScanDigest);

    // Receipt: the claimed keys only, all filled.
    expect(result.ok).toBe(true);
    expect(server.bodyOf('POST', '/receipts')).toMatchObject({
      executionLease: 'opaque-lease-chain',
      missionStepId: server.state.executionStepId,
      intentVersion: 1,
      outcome: 'FILL_SUCCEEDED',
      fieldResults: [
        { fieldKey: 'email', outcomeCode: 'FILLED' },
        { fieldKey: 'firstName', outcomeCode: 'FILLED' },
        { fieldKey: 'lastName', outcomeCode: 'FILLED' },
      ],
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      'DOCK_MISSION_RUN_CLAIMED',
      'DOCK_MISSION_RECEIPT_SENT',
      'RESUME_ATTACHMENT_MISSION_RELEASED',
      'DOCK_MISSION_COVER_LETTER_WRITTEN',
    ]));
    // Diagnostics are stable codes only: no letter, résumé name, lease or address in them.
    expect(diagnostics.every((code) => /^[A-Z][A-Z0-9_]*$/.test(code))).toBe(true);
  });

  it('fills the tailored résumé and the letter the form requires from the Mission materials entry, never the prepared lookup', async () => {
    const server = fakeArgoland();
    const { send, hello } = worker(server);
    const { descriptor } = applicationPage();
    await hello();

    expect(coverLetterDemand(descriptor), 'precondition: the form insists on a letter').toBe('REQUIRED');
    const { result } = await dockRun(send, descriptor, { missionBound: true });

    expect(result.ok).toBe(true);
    expect(value('first_name')).toBe('Avery');
    expect(value('last_name')).toBe('ChainTest');
    expect(value('email')).toBe('avery@example.test');
    expect(value('cover_letter_text')).toBe(COVER_LETTER_TEXT);
    const attached = (document.getElementById('resume') as HTMLInputElement).files?.[0];
    expect(attached?.name).toBe('Avery ChainTest Resume.pdf');
    expect(attached?.size).toBe(RESUME_BYTES.byteLength);

    const materialPaths = server.paths().filter((path) => /materials|resume-attachments/.test(path));
    expect(materialPaths).toEqual(expect.arrayContaining([
      'GET /api/v1/agent/missions/:id/materials',
      'POST /api/v1/agent/missions/:id/materials/resume',
      'POST /api/v1/agent/missions/:id/materials/cover-letter',
      'POST /api/v1/agent/missions/:id/materials/cover-letter/text',
    ]));
    expect(materialPaths.some((path) => path.includes('/resume-attachments'))).toBe(false);
    expect(server.bodyOf('POST', '/materials/cover-letter')).toMatchObject({ trigger: 'FORM_REQUIRED' });
    // The letter and the file are Data-L1: they never ride on the receipt.
    expect(JSON.stringify(server.bodyOf('POST', '/receipts') ?? {})).not.toContain('Dear Hiring Team');
  });

  it("reports the submission after the user's own 提交 in the dock and the site's confirmation", async () => {
    const server = fakeArgoland();
    const { send, hello, mission } = worker(server);
    const { descriptor, siteSubmits } = applicationPage();
    await hello();
    const { session } = await dockRun(send, descriptor, { missionBound: true });
    await until(() => server.paths().includes('POST /api/v1/agent/missions/:id/receipts'));

    const submitter = createSubmitController({
      document,
      isVisible: () => true,
      resolvePolicy: async () => livePolicy({ 'submit-application': true }),
      // DOCK_SUBMIT_PRESSED reaches the worker from the top frame, as in background.ts.
      onPressing: () => { mission.submitPressed(TAB_ID); },
      pollMs: 5,
      settleMs: 300,
      rejectAfterMs: 40,
    });
    submitter.arm({ descriptor, policy: livePolicy({ 'submit-application': true }) });
    expect(submitter.available()).toBe(true);
    expect(server.paths()).not.toContain('POST /api/v1/agent/missions/:id/submission-events');

    const outcome = clickInOurShadow((event, shadowRoot) => {
      const sent = submitter.send(event, shadowRoot, Promise.resolve());
      session.afterDockSubmit(sent);
      return sent;
    });
    await expect(outcome).resolves.toBe('SUBMITTED');
    await until(() => server.paths().includes('POST /api/v1/agent/missions/:id/submission-events'));

    expect(siteSubmits).toHaveBeenCalledTimes(1);
    const tail = server.paths().slice(-2);
    expect(tail).toEqual(['GET /api/v1/agent/missions/:id', 'POST /api/v1/agent/missions/:id/submission-events']);
    expect(server.bodyOf('POST', '/submission-events')).toMatchObject({
      eventType: 'USER_REPORTED_SUBMISSION',
      applicationId: BINDING.application.applicationId,
      expectedApplicationRevision: '4',
      applicationBundleVersion: BINDING.application.applicationBundleVersion,
    });
  });

  it('a confirmation with no 提交 pressed in this tab reports nothing', async () => {
    const server = fakeArgoland();
    const { send, hello } = worker(server);
    const { descriptor } = applicationPage();
    await hello();
    const { session } = await dockRun(send, descriptor, { missionBound: true });

    session.confirmSubmitted();
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(server.paths().some((path) => path.includes('submission-events'))).toBe(false);
  });

  it('a Mission that cannot be recorded never blocks the fill (issue refused → no run, the page is still filled)', async () => {
    const server = fakeArgoland({ issueStatus: 409 });
    const { send, hello, diagnostics } = worker(server);
    const { descriptor } = applicationPage();
    await hello();

    const { result, ticket } = await dockRun(send, descriptor, { missionBound: true });

    expect(ticket).toBeNull();
    expect(result.ok).toBe(true);
    expect(value('first_name')).toBe('Avery');
    expect(value('cover_letter_text')).toBe(COVER_LETTER_TEXT);
    expect(server.paths().some((path) => /claim|receipts/.test(path))).toBe(false);
    expect(diagnostics).toContain('DOCK_MISSION_INTENT_UNAVAILABLE');
  });

  it('a claimed key the profile has no value for is reported as the user’s to finish (USER_ACTION_REQUIRED, never FILL_PARTIAL)', async () => {
    const server = fakeArgoland();
    const { send, hello } = worker(server);
    const { descriptor } = applicationPage();
    await hello();

    await dockRun(send, descriptor, {
      missionBound: true,
      profile: { firstName: 'Avery', email: 'avery@example.test' },
    });
    await until(() => server.paths().includes('POST /api/v1/agent/missions/:id/receipts'));

    expect(server.bodyOf('POST', '/receipts')).toMatchObject({
      outcome: 'USER_ACTION_REQUIRED',
      fieldResults: [
        { fieldKey: 'email', outcomeCode: 'FILLED' },
        { fieldKey: 'firstName', outcomeCode: 'FILLED' },
        { fieldKey: 'lastName', outcomeCode: 'NEEDS_USER_INPUT' },
      ],
    });
  });

  it('a Mission résumé that is not ready is refused as such: no fallback to the prepared or default résumé', async () => {
    const server = fakeArgoland({ resume: 'UNAVAILABLE' });
    const { send, hello } = worker(server);
    const { descriptor } = applicationPage();
    await hello();

    await dockRun(send, descriptor, { missionBound: true });

    expect((document.getElementById('resume') as HTMLInputElement).files?.length ?? 0).toBe(0);
    expect(value('first_name')).toBe('Avery');
    expect(server.paths().some((path) => path.includes('/resume-attachments'))).toBe(false);
    expect(server.paths().some((path) => path.endsWith('/materials/resume'))).toBe(false);
  });

  it('an optional letter box is not written for (the letter is charged only when the form requires it)', async () => {
    const server = fakeArgoland();
    const { send, hello } = worker(server);
    const { descriptor } = applicationPage({ letterRequired: false });
    await hello();

    expect(coverLetterDemand(descriptor)).toBe('OPTIONAL');
    await dockRun(send, descriptor, { missionBound: true });

    expect(value('cover_letter_text')).toBe('');
    expect(server.paths().some((path) => path.includes('/cover-letter'))).toBe(false);
  });
});

describe('A page with no Mission: the gesture path, unchanged', () => {
  it('asks no Mission endpoint, attaches through the prepared lookup, and reports no submission', async () => {
    const server = fakeArgoland({ bound: false });
    const { send, hello, mission } = worker(server);
    const { descriptor } = applicationPage();

    await expect(hello(), 'the dock shows the NO_MISSION face').resolves.toBe(false);
    const { result } = await dockRun(send, descriptor, { missionBound: false });
    mission.submitPressed(TAB_ID);
    await expect(send(createDockSubmitConfirmedIntent(PAGE.origin, PAGE.pathname))).resolves.toEqual({ ok: false });

    expect(result.ok).toBe(true);
    expect(value('first_name')).toBe('Avery');
    expect(value('cover_letter_text'), 'no Mission, no letter').toBe('');
    expect(server.paths().some((path) => path.includes('/resume-attachments/prepared'))).toBe(true);
    expect(server.paths().filter((path) => path.includes('/missions/') && !path.endsWith('/page-binding'))).toEqual([]);
  });

  it('a Mission message on a page the tab is not on is dropped (sender check)', async () => {
    const server = fakeArgoland();
    const { mission } = worker(server);

    const reply = mission.handle(
      createDockMissionCoverLetterIntent(PAGE.origin, '/argoland-chain-fixture/jobs/1', 'FORM_REQUIRED'),
      SENDER,
    );
    await expect(reply).resolves.toBeUndefined();
    expect(server.calls).toEqual([]);
  });
});
