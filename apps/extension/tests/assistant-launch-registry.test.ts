import { describe, expect, it, vi } from 'vitest';
import { createAssistantLaunchRegistry } from '../assistant/runtime/launch-registry';

const base = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/assistant.html';
const launch = { layoutNonce: '30000000-0000-4000-8000-000000000001', tabId: 7, topDocumentId: 'top-document', topUrl: 'https://jobs.example.test/a',
  frameUrl: `${base}?launch=20000000-0000-4000-8000-000000000001` };
function setup() {
  const data: Record<string, unknown> = {};
  const store = { get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }) };
  return { store, data, registry: createAssistantLaunchRegistry(store, base) };
}
describe('assistant browser-session registration', () => {
  it('restores exact routing after restart and shares one current entry across concurrent callers', async () => {
    const h = setup(); expect(await h.registry.set(launch)).toBe(true);
    const restarted = createAssistantLaunchRegistry(h.store, base);
    const [first, second] = await Promise.all([restarted.get(7), restarted.get(7)]);
    expect(first).toEqual(launch); expect(second).toBe(first);
    expect(Object.keys(h.data)).toEqual(['assistantLaunchV1:7']);
    expect(Object.keys(first!)).toEqual(Object.keys(launch));
    await restarted.delete(7);
    expect(await createAssistantLaunchRegistry(h.store, base).get(7)).toBeUndefined();
  });
  it('cannot resurrect a removed entry from a delayed read', async () => {
    const h = setup(); await h.registry.set(launch);
    const restarted = createAssistantLaunchRegistry(h.store, base);
    let resolve!: (value: Record<string, unknown>) => void;
    h.store.get.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const reading = restarted.get(7); await Promise.resolve();
    await restarted.delete(7); resolve({ 'assistantLaunchV1:7': launch });
    expect(await reading).toBeUndefined(); expect(restarted.peek(7)).toBeUndefined();
  });
  it('orders removal after a pending save and refuses to activate the obsolete launch', async () => {
    const h = setup(); let finish!: () => void;
    h.store.set.mockImplementationOnce(async values => { await new Promise<void>(r => { finish = r; }); Object.assign(h.data, values); });
    const saving = h.registry.set(launch); await Promise.resolve();
    const removing = h.registry.delete(7); finish();
    expect(await saving).toBe(false); await removing;
    expect(h.registry.peek(7)).toBeUndefined(); expect(h.data).toEqual({});
  });
  it('rejects altered schemas, other extensions and failed storage without a memory fallback', async () => {
    const h = setup();
    for (const invalid of [{ ...launch, ownerId: 'forbidden' }, { ...launch, tabId: 8 },
      { ...launch, frameUrl: 'https://attacker.invalid/assistant.html' }, { ...launch, topDocumentId: '' }]) {
      h.data['assistantLaunchV1:7'] = invalid;
      expect(await createAssistantLaunchRegistry(h.store, base).get(7)).toBeUndefined();
    }
    h.store.get.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    await expect(h.registry.get(7)).rejects.toThrow('UNAVAILABLE');
    h.store.set.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    await expect(h.registry.set(launch)).rejects.toThrow('UNAVAILABLE');
    expect(h.registry.peek(7)).toBeUndefined();
  });
});
