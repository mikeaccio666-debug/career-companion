import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTAKE_RECORDER_PORT, type AssistantSessionIdentity, type IntakeView } from '@edaix/contracts';
import { encodeIntakePcm } from '../assistant/features/intake/audio';
const browserMock = vi.hoisted(() => ({ runtime: { id: 'extension-test', onConnect: { addListener: vi.fn() },
  getURL: (path: string) => `chrome-extension://extension-test${path}`, getContexts: vi.fn(async () => [{ documentId: 'recorder-document' }]) },
  tabs: { create: vi.fn(async () => ({ id: 12 })), update: vi.fn(async (_id: number, _options: { url: string }) => ({})), remove: vi.fn(), onRemoved: { addListener: vi.fn() } } }));
vi.mock('wxt/browser', () => ({ browser: browserMock }));
import { installIntakeVoiceWorker } from '../assistant/runtime/intake-voice-worker';
import type { createOwnerIntake } from '../assistant/features/intake/owner-intake';
const owner = '10000000-0000-4000-8000-000000000011', id = '10000000-0000-4000-8000-000000000012';
const view: IntakeView = { schemaVersion: 1, session: { schemaVersion: 1, id: id as never, revision: '0', locale: 'en-US', turns: [], noProgressTurns: 0, selectedRoleId: null },
  configuration: { version: 'test', maxRecordingSeconds: 60, chunkSeconds: 30, nudgeAfterTurns: 3, maxSessionTurns: 20 },
  usage: { replies: { state: 'EXHAUSTED', remaining: 0, resetsAt: '2027-01-01T00:00:00Z' }, speechSeconds: { state: 'AVAILABLE', remaining: 300, resetsAt: '2027-01-01T00:00:00Z' } } };
function port(sender?: unknown) { return { name: INTAKE_RECORDER_PORT, sender, postMessage: vi.fn(), disconnect: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } }; }
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.clearAllMocks(); });
function harness() {
  let identity: AssistantSessionIdentity | null = { ownerId: owner as never, generation: 1 };
  const api = { execute: vi.fn(async () => ({ ok: true, value: view })), speech: vi.fn() };
  const worker = installIntakeVoiceWorker(api as unknown as ReturnType<typeof createOwnerIntake>, async () => identity, () => 'en-US'); cleanup.push(worker.invalidate);
  const parent = port(), signal = new AbortController();
  const start = async () => { await worker.control(parent as never, { kind: 'assistant/voice-control-v1', id, operation: 'START' }, identity!, signal.signal, async () => true);
    const url = browserMock.tabs.update.mock.calls.at(-1)![1] as { url: string };
    const recorder = port({ id: 'extension-test', tab: { id: 12 }, frameId: 0, documentId: 'recorder-document', url: url.url });
    browserMock.runtime.onConnect.addListener.mock.calls.at(-1)![0](recorder);
    const send = (value: unknown) => recorder.onMessage.addListener.mock.calls[0]![0](value);
    send({ kind: 'READY' }); await vi.waitFor(() => expect(recorder.postMessage).toHaveBeenCalledWith({ kind: 'START', maximumSeconds: 60, chunkSeconds: 30 }));
    return { recorder, send };
  };
  return { api, worker, parent, signal, start, setIdentity: (value: AssistantSessionIdentity | null) => { identity = value; } };
}
function chunk(index = 0, samples = 16000) { return { kind: 'CHUNK', index, base64: Buffer.from(encodeIntakePcm(new Float32Array(samples).fill(.2))).toString('base64') }; }
describe('authenticated voice recorder lifecycle', () => {
  it('rejects a recorder that was not created by an authenticated Assistant', () => {
    const h = harness(), recorder = port({ id: 'extension-test', tab: { id: 12 }, frameId: 0, documentId: 'recorder-document' });
    browserMock.runtime.onConnect.addListener.mock.calls.at(-1)![0](recorder);
    expect(recorder.disconnect).toHaveBeenCalledOnce(); expect(h.api.speech).not.toHaveBeenCalled();
  });
  it('transcribes with zero AI replies and waits for the final in-flight chunk on stop', async () => {
    const h = harness(), recorder = await h.start();
    let finish!: (value: unknown) => void; h.api.speech.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    recorder.send(chunk()); await vi.waitFor(() => expect(h.api.speech).toHaveBeenCalledOnce());
    recorder.send({ kind: 'STOPPED' });
    expect(h.parent.postMessage.mock.calls.some(([v]) => v.event === 'END')).toBe(false);
    const request = h.api.speech.mock.calls[0]![2];
    finish({ ok: true, value: { ...view, session: { ...view.session, revision: '2', turns: [{ id: request, kind: 'SPEECH', status: 'COMPLETED', text: 'Editable transcript' }] } } });
    await vi.waitFor(() => expect(h.parent.postMessage).toHaveBeenCalledWith({ kind: 'assistant/voice-event-v1', id, event: 'TRANSCRIPT', text: 'Editable transcript' }));
    await vi.waitFor(() => expect(h.parent.postMessage).toHaveBeenCalledWith({ kind: 'assistant/voice-event-v1', id, event: 'END', code: null }));
  });
  it('aborts an upload on parent close and suppresses its late transcript', async () => {
    const h = harness(), recorder = await h.start();
    let finish!: (value: unknown) => void; h.api.speech.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    recorder.send(chunk()); await vi.waitFor(() => expect(h.api.speech).toHaveBeenCalledOnce());
    const args = h.api.speech.mock.calls[0]!; h.signal.abort(); expect((args[5] as AbortSignal).aborted).toBe(true);
    finish({ ok: true, value: view }); await Promise.resolve();
    expect(h.parent.postMessage.mock.calls.some(([v]) => v.event === 'TRANSCRIPT')).toBe(false);
    expect(recorder.recorder.disconnect).toHaveBeenCalledOnce();
  });
  it('rejects reordered chunks before calling the backend', async () => {
    const h = harness(), recorder = await h.start(); recorder.send(chunk(1));
    expect(h.api.speech).not.toHaveBeenCalled();
    expect(h.parent.postMessage).toHaveBeenCalledWith({ kind: 'assistant/voice-event-v1', id, event: 'END', code: 'LIMIT_REACHED' });
  });
});
