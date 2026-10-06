import { describe, expect, it, vi } from 'vitest';
import { createApplicationQuestionClient } from '../lib/applicationQuestionClient';
import { handleApplicationQuestionMessage } from '../lib/applicationQuestionMessages';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const missionId = uuid(5);
const page = { missionId, pageId: `sha256:${'a'.repeat(64)}`, pageGeneration: '1' };
const question = { questionId: 'q3', text: 'Why do you want to work here?', controlType: 'TEXTAREA', required: true, options: [] };

function fakeApi() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith(`/api/v1/agent/missions/${missionId}`)) {
      return json({ schemaVersion: 1, mission: { id: missionId, application: { canonicalJobId: uuid(6), applicationBundleVersion: '3' } } });
    }
    if (url.endsWith('/api/v1/agent/application-question-candidates')) {
      const batch = JSON.parse(String(init.body)) as { requestId: string; context: unknown };
      return json({ schemaVersion: 1, ok: true, requestId: batch.requestId, context: batch.context, persisted: false, deliveryAuthorized: false,
        candidates: [{ questionId: 'q3', disposition: 'NEEDS_USER_INPUT', reasonCode: 'EVIDENCE_MISSING', answer: null, confidence: 'NONE', provenance: [] }] });
    }
    return json({}, 404);
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

describe('application question client', () => {
  it('assembles the exact mission context in the background and posts the batch privately', async () => {
    const api = fakeApi();
    const client = createApplicationQuestionClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => 'token',
      getInstallId: async () => uuid(4),
      resolveTarget: async () => ({ missionRevision: '2', revision: '7' }),
      fetchFn: api.fetchFn,
    });
    const reply = await handleApplicationQuestionMessage(client, 'application-question/candidates', { ...page, questions: [question] });
    expect(reply).toMatchObject({ ok: true, result: { ok: true, candidates: [{ questionId: 'q3', disposition: 'NEEDS_USER_INPUT' }] } });
    const post = api.calls.find((call) => call.url.endsWith('application-question-candidates'))!;
    expect(post.init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(JSON.parse(String(post.init.body))).toMatchObject({
      context: { extensionInstallId: uuid(4), missionId, missionRevision: '2', canonicalJobId: uuid(6), applicationBundleVersion: '3', applicationTargetRevision: '7', pageId: page.pageId, pageGeneration: '1' },
      questions: [question],
    });
  });

  it('stays off without an API origin and never calls fetch', async () => {
    const api = fakeApi();
    const client = createApplicationQuestionClient({ apiBase: null, getAccessToken: async () => 'token', getInstallId: async () => uuid(4), resolveTarget: async () => null, fetchFn: api.fetchFn });
    expect(await handleApplicationQuestionMessage(client, 'application-question/settings-get', {})).toEqual({ ok: false, code: 'DISABLED' });
    expect(api.calls).toHaveLength(0);
  });
});

describe('answer recheck against the server', () => {
  const settingsOn = { schemaVersion: 1, enabled: true, autoReuse: false, revision: '1', disclosureVersion: '2026-09-10' };
  const context = { extensionInstallId: uuid(4), missionId, missionRevision: '2', canonicalJobId: uuid(6), applicationBundleVersion: '3', applicationTargetRevision: '7', pageId: page.pageId, pageGeneration: '1' };

  function clientWith(settings: unknown, target: { missionRevision: string; revision: string } | null) {
    const api = fakeApi();
    const fetchFn: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/v1/agent/application-question-settings')) {
        return new Response(JSON.stringify(settings), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return api.fetchFn(url, init);
    };
    return createApplicationQuestionClient({ apiBase: 'https://api.example.test', getAccessToken: async () => 'token', getInstallId: async () => uuid(4), resolveTarget: async () => target, fetchFn });
  }

  it('is current only while the feature is on and the Mission, target and bundle still match the candidates', async () => {
    const client = clientWith(settingsOn, { missionRevision: '2', revision: '7' });
    expect(await handleApplicationQuestionMessage(client, 'application-question/recheck', { ...page, context })).toEqual({ ok: true, current: true });
  });

  it.each([
    ['the feature was disabled', { ...settingsOn, enabled: false }, { missionRevision: '2', revision: '7' }],
    ['the target was re-verified', settingsOn, { missionRevision: '2', revision: '8' }],
    ['the Mission moved on', settingsOn, { missionRevision: '3', revision: '7' }],
    ['the target is no longer available', settingsOn, null],
  ])('is stale after %s', async (_name, settings, target) => {
    const client = clientWith(settings, target);
    expect(await handleApplicationQuestionMessage(client, 'application-question/recheck', { ...page, context })).toEqual({ ok: true, current: false });
  });
});

/**
 * Independent review round 3 (2026-09-10): the background re-read the Mission context for the
 * memory POST, so an answer confirmed under revision 1 was posted under revision 2 after the
 * Mission moved on. The confirmed context now travels with the request; the fresh read may only
 * reject drift, never replace it.
 */
describe('remember keeps the confirmed context', () => {
  const settingsOn = { schemaVersion: 1, enabled: true, autoReuse: false, revision: '1', disclosureVersion: '2026-09-10' };
  const confirmed = { extensionInstallId: uuid(4), missionId, missionRevision: '2', canonicalJobId: uuid(6), applicationBundleVersion: '3', applicationTargetRevision: '7', pageId: page.pageId, pageGeneration: '1' };
  const memory = { question: { text: 'Why do you want to work here?', controlType: 'TEXTAREA', optionTexts: [] }, answer: { kind: 'TEXT', text: 'Because.' }, scope: 'APPLICATION', answerClass: 'APPLICATION_INSTANCE' };

  function clientWith(target: { missionRevision: string; revision: string } | null, posts: unknown[]) {
    const api = fakeApi();
    const fetchFn: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/v1/agent/application-question-settings')) {
        return new Response(JSON.stringify(settingsOn), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/api/v1/agent/application-question-answers') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return new Response(JSON.stringify({ id: uuid(77), question: body.question, answer: body.answer, scope: body.scope, answerClass: body.answerClass, canonicalJobId: uuid(6), revision: '1', createdAt: 'x', updatedAt: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return api.fetchFn(url, init);
    };
    return createApplicationQuestionClient({ apiBase: 'https://api.example.test', getAccessToken: async () => 'token', getInstallId: async () => uuid(4), resolveTarget: async () => target, fetchFn });
  }

  it('posts exactly the confirmed context, value, scope and question when nothing drifted', async () => {
    const posts: Record<string, unknown>[] = [];
    const client = clientWith({ missionRevision: '2', revision: '7' }, posts);
    const reply = await handleApplicationQuestionMessage(client, 'application-question/remember', { ...page, context: confirmed, ...memory });
    expect(reply).toMatchObject({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ context: confirmed, question: memory.question, answer: memory.answer, scope: 'APPLICATION', answerClass: 'APPLICATION_INSTANCE' });
  });

  it.each([
    ['the Mission moved on', { missionRevision: '3', revision: '7' }],
    ['the target was re-verified', { missionRevision: '2', revision: '8' }],
    ['the target is gone', null],
  ])('refuses to save and never rebinds when %s after the click', async (_name, target) => {
    const posts: unknown[] = [];
    const client = clientWith(target, posts);
    const reply = await handleApplicationQuestionMessage(client, 'application-question/remember', { ...page, context: confirmed, ...memory });
    expect(reply).toEqual({ ok: false, code: 'STALE' });
    expect(posts).toHaveLength(0);
  });

  it('refuses a remember without the confirmed context', async () => {
    const posts: unknown[] = [];
    const client = clientWith({ missionRevision: '2', revision: '7' }, posts);
    expect(await handleApplicationQuestionMessage(client, 'application-question/remember', { ...page, ...memory })).toEqual({ ok: false, code: 'INVALID' });
    expect(posts).toHaveLength(0);
  });
});
