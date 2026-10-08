import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanionWelcome } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { CompanionWelcomeController, type WelcomeViewState } from '../src/companion-welcome-controller.ts';
import { id } from './fixtures/companion-birth.ts';
const at = '2026-10-08T12:00:00.000Z';
const welcome: CompanionWelcome = {
    kind: 'welcome', id: id(20), companionId: id(4), conversationId: id(6),
    revision: 1, step: 'C1', choice: null, openedAt: at, updatedAt: at,
    intro: { id: id(21), kind: 'text', rendering: 'fixed_intro_v1',
        content: '我是墨，名字是你起的。我是 AI。我们先花三分钟认识一下，然后我给你写第一封信。',
        createdAt: at, speaker: { name: '墨', sealChar: '墨', inkToken: 'dai', personaRevision: 1 } },
};
const progressed = (choice: 'begin' | 'direct_letter'): CompanionWelcome => ({
    ...welcome, revision: 2, step: choice === 'begin' ? 'C2' : 'C7', choice,
});
const flush = async () => { for (let i = 0; i < 15; i++)
    await new Promise<void>(r => setImmediate(r)); };
const commandKey = `companion.welcome.choice.v1:${id(1)}:${id(4)}`;
function harness(transport: (path: string, init: RequestInit) => Promise<Response>, saved = new Map<string, string>()) {
    const context = new AccountRequestContext();
    context.changeSession(id(1));
    const calls: {
        path: string;
        method: string;
        body: any;
    }[] = [];
    const client = createPlatformClient(createPlatformEndpoints('https://api.example.invalid'), async (url, init = {}) => {
        const path = new URL(String(url)).pathname.replace('/api/platform', '');
        calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
        return transport(path, init);
    }, context).capture();
    const observations: WelcomeViewState[] = [];
    let now = 0, sequence = 0, paused = false;
    const timers = new Map<number, {
        at: number;
        run: () => void;
    }>();
    const store = { read: (key: string) => saved.get(key) ?? null,
        write: (key: string, value: string) => { saved.set(key, value); }, remove: (key: string) => { saved.delete(key); } };
    const timing = { now: () => now, isVisible: () => true, isOnline: () => true, operationId: () => id(100 + ++sequence),
        setTimer: (run: () => void, ms: number) => { const key = ++sequence; timers.set(key, { at: now + ms, run }); return key; },
        clearTimer: (key: unknown) => { timers.delete(key as number); } };
    const controller = new CompanionWelcomeController(client, id(4), state => observations.push(state), () => paused, timing, store);
    return { controller, context, calls, saved, store, timers, latest: () => observations.at(-1)!, pause: (v: boolean) => { paused = v; },
        async advance(ms: number) { now += ms; for (const [key, t] of [...timers])
            if (t.at <= now) {
                timers.delete(key);
                t.run();
                await flush();
            } } };
}
test('documented C1 opening uses the saved birth source once; reconnects and StrictMode replays only read it', async () => {
    let published = false;
    const h = harness(async (_path, init) => {
        if (init.method === 'POST') {
            published = true;
            return Response.json(welcome);
        }
        return Response.json(published ? welcome : { kind: 'not_opened' });
    });
    h.controller.start();
    await flush();
    h.controller.stop();
    h.controller.start();
    await flush();
    h.controller.refresh();
    await flush();
    assert.deepEqual(h.calls.filter(c => c.method === 'POST').map(c => c.body), [{ expectedCompanionId: id(4) }]);
    assert.equal(h.latest().welcome?.step, 'C1');
    assert.equal(h.saved.size, 0);
    h.controller.stop();
});
test('lost opening response recovers the real saved introduction using GET, without another POST', async () => {
    let published = false;
    const h = harness(async (_path, init) => {
        if (init.method === 'POST') {
            published = true;
            throw new TypeError('Fictional lost response');
        }
        return Response.json(published ? welcome : { kind: 'not_opened' });
    });
    h.controller.start();
    await flush();
    assert(h.latest().error);
    await h.advance(3000);
    assert.equal(h.latest().welcome?.id, welcome.id);
    assert.equal(h.latest().error, '');
    assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
    h.controller.stop();
});
test('an absent opening keeps a useful retry after a successful GET; only explicit retry repeats publication', async () => {
    const h = harness(async (_path, init) => init.method === 'POST'
        ? Promise.reject(new TypeError('Fictional connection loss')) : Response.json({ kind: 'not_opened' }));
    h.controller.start();
    await flush();
    await h.advance(3000);
    assert.match(h.latest().error, /还没有确认保存/);
    assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
    h.controller.retryOpen();
    await flush();
    assert.equal(h.calls.filter(c => c.method === 'POST').length, 2);
    h.controller.stop();
});
test('a response for another companion cannot become this companion or enable choosing', async () => {
    const h = harness(async () => Response.json({ ...welcome, companionId: id(90) }));
    h.controller.start();
    await flush();
    assert.equal(h.latest().welcome, null);
    assert.equal(h.controller.choose('begin'), false);
    assert(h.calls.every(c => c.method === 'GET'));
    h.controller.stop();
});
test('one explicit choice freezes its source and operation, ignores double clicks and clears the saved intent only after confirmation', async () => {
    let state = welcome;
    const h = harness(async (_path, init) => {
        if (init.method === 'POST') {
            const body = JSON.parse(String(init.body));
            state = progressed(body.choice);
            return Response.json({ state, operation: { id: body.operationId, appliedRevision: 2, replayed: false } });
        }
        return Response.json(state);
    });
    h.controller.start();
    await flush();
    assert(h.controller.choose('begin'));
    assert.equal(h.controller.choose('direct_letter'), false);
    await flush();
    const writes = h.calls.filter(c => c.method === 'POST');
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0].body).sort(), ['choice', 'expectedRevision', 'operationId', 'welcomeId']);
    assert.equal(writes[0].body.welcomeId, welcome.id);
    assert.equal(writes[0].body.choice, 'begin');
    assert.equal(h.latest().welcome?.step, 'C2');
    assert.equal(h.saved.size, 0);
    h.controller.stop();
});
test('ambiguous choice remains source-bound across controller remount; explicit retry reuses the exact saved command', async () => {
    const transport = async (_path: string, init: RequestInit) => init.method === 'POST'
        ? Promise.reject(new TypeError('Fictional lost choice response')) : Response.json(welcome);
    const first = harness(transport);
    first.controller.start();
    await flush();
    first.controller.choose('direct_letter');
    await flush();
    const original = first.calls.find(c => c.method === 'POST')!.body;
    assert(first.latest().uncertain);
    assert.equal(first.controller.choose('begin'), false);
    first.controller.stop();
    const next = harness(transport, first.saved);
    next.controller.start();
    await flush();
    assert(next.latest().uncertain);
    assert(next.calls.every(c => c.method === 'GET'));
    assert(next.controller.retryChoice());
    await flush();
    assert.deepEqual(next.calls.find(c => c.method === 'POST')!.body, original);
    next.controller.stop();
});
test('another device can advance the journey; a missing local receipt never overwrites its saved choice', async () => {
    const pending = { operationId: id(100), welcomeId: welcome.id, expectedRevision: 1, choice: 'begin' };
    const h = harness(async () => Response.json(progressed('direct_letter')), new Map([[commandKey, JSON.stringify(pending)]]));
    h.controller.start();
    await flush();
    assert.equal(h.latest().welcome?.step, 'C7');
    assert.equal(h.latest().uncertain, false);
    assert.equal(h.saved.size, 0);
    assert.equal(h.controller.choose('begin'), false);
    assert(h.calls.every(c => c.method === 'GET'));
    h.controller.stop();
});
test('changing accounts clears private state and rejects a late choice response', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    const h = harness(async (_path, init) => init.method === 'POST' ? pending : Response.json(welcome));
    h.controller.start();
    await flush();
    h.controller.choose('begin');
    const body = h.calls.find(c => c.method === 'POST')!.body;
    h.context.changeSession(id(9));
    resolve(Response.json({ state: progressed('begin'), operation: { id: body.operationId, appliedRevision: 2, replayed: false } }));
    await flush();
    assert.equal(h.latest().welcome, null);
    assert.equal(h.latest().error, '');
    assert.equal(h.timers.size, 0);
    assert.equal(h.controller.retryChoice(), false);
});
test('disabled intent storage prevents all choice writes while saved C1 stays readable', async () => {
    const h = harness(async () => Response.json(welcome));
    h.store.write = () => { throw Error('Fictional unavailable storage'); };
    h.controller.start();
    await flush();
    assert.equal(h.controller.choose('begin'), false);
    assert.match(h.latest().error, /暂时无法准备/);
    assert(h.calls.every(c => c.method === 'GET'));
    assert.equal(h.latest().welcome?.id, welcome.id);
    h.controller.stop();
});
test('support pause allows private reads but prevents new C1 publication and choice', async () => {
    const h = harness(async () => Response.json({ kind: 'not_opened' }));
    h.pause(true);
    h.controller.start();
    await flush();
    assert(h.calls.every(c => c.method === 'GET'));
    h.controller.retryOpen();
    await flush();
    assert(h.calls.every(c => c.method === 'GET'));
    h.controller.stop();
    const saved = harness(async () => Response.json(welcome));
    saved.pause(true);
    saved.controller.start();
    await flush();
    assert.equal(saved.latest().welcome?.id, welcome.id);
    assert.equal(saved.controller.choose('begin'), false);
    saved.controller.stop();
});
test('choice quota stops all traffic for at least 60 seconds; recovery never automatically repeats the choice', async () => {
    const h = harness(async (_path, init) => init.method === 'POST'
        ? Response.json({ error: { code: 'REQUEST_LIMIT_REACHED', message: 'Fictional quota' } }, { status: 429, headers: { 'Retry-After': '2' } })
        : Response.json(welcome));
    h.controller.start();
    await flush();
    h.controller.choose('begin');
    await flush();
    const count = h.calls.length;
    await h.advance(59000);
    assert.equal(h.calls.length, count);
    assert.equal(h.controller.retryChoice(), false);
    await h.advance(1000);
    assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
    assert(h.latest().uncertain);
    h.controller.stop();
});
test('a stale saved command cannot be moved to another welcome source', async () => {
    const pending = { operationId: id(100), welcomeId: id(91), expectedRevision: 1, choice: 'begin' };
    const h = harness(async () => Response.json(welcome), new Map([[commandKey, JSON.stringify(pending)]]));
    h.controller.start();
    await flush();
    assert.equal(h.saved.size, 0);
    assert.equal(h.latest().uncertain, false);
    assert(h.calls.every(c => c.method === 'GET'));
    h.controller.stop();
});
