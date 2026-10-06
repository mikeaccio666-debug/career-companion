import { describe, expect, it, vi } from 'vitest';
import type { IntakeView } from '@edaix/contracts';
import { createOwnerIntake, intakeEvents } from '../assistant/features/intake/owner-intake';
const owner = { ownerId: '10000000-0000-4000-8000-000000000011' as never, generation: 1 };
const id = '10000000-0000-4000-8000-000000000012' as never;
const view: IntakeView = { schemaVersion: 1, session: null, configuration: null,
  usage: { replies: { state: 'EXHAUSTED', remaining: 0, resetsAt: '2027-01-01T00:00:00Z' }, speechSeconds: { state: 'AVAILABLE', remaining: 300, resetsAt: '2027-01-01T00:00:00Z' } } };
describe('owner intake HTTP consumer', () => {
  it('distinguishes the provider attempt ceiling from successful usage exhaustion', async () => {
    const client = createOwnerIntake({ apiBase: 'https://api.example.test', currentSession: async () => owner, accessToken: async () => 'synthetic', fetchFn: vi.fn(async () => Response.json({code:'RATE_LIMITED'},{status:429})) });
    expect(await client.execute(owner,{operation:'START',request:{clientRequestId:id,locale:'en-US'}},new AbortController().signal,async()=>true)).toEqual({ok:false,code:'RATE_LIMITED'});
  });
  it('accepts whitespace deltas and refuses a truncated terminal frame', async () => {
    const event = { kind: 'intake.delta', sessionId: id, turnId: id, sequence: 0, text: ' ' };
    const events = []; for await (const value of intakeEvents(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }), new AbortController().signal)) events.push(value);
    expect(events).toEqual([event]);
    const consume = async () => { for await (const _event of intakeEvents(new Response('data: {', { headers: { 'content-type': 'text/event-stream' } }), new AbortController().signal)) { /* drain */ } };
    await expect(consume()).rejects.toThrow('INTAKE_STREAM_TRUNCATED');
  });
  it('does not return an old-owner response after the account changes during fetch', async () => {
    let current = owner;
    const fetcher = vi.fn(async () => { current = { ...owner, generation: 2 }; return Response.json(view); });
    const client = createOwnerIntake({ apiBase: 'https://api.example.test', currentSession: async () => current, accessToken: async () => 'synthetic', fetchFn: fetcher });
    expect(await client.execute(owner, { operation: 'CURRENT' }, new AbortController().signal, async () => true)).toEqual({ ok: false, code: 'OWNER_CHANGED' });
  });
  it('checks sender and request shape before fetching and never retries an uncertain write', async () => {
    const fetcher = vi.fn(async () => { throw new Error('transport failed'); });
    const client = createOwnerIntake({ apiBase: 'https://api.example.test', currentSession: async () => owner, accessToken: async () => 'synthetic', fetchFn: fetcher });
    expect(await client.execute(owner, { operation: 'CURRENT' }, new AbortController().signal, async () => false)).toEqual({ ok: false, code: 'SENDER_REJECTED' }); expect(fetcher).not.toHaveBeenCalled();
    expect(await client.speech(owner, '../escape', id, '0', new Uint8Array(), new AbortController().signal, async () => true)).toEqual({ ok: false, code: 'VALIDATION_FAILED' }); expect(fetcher).not.toHaveBeenCalled();
    expect(await client.execute(owner, { operation: 'START', request: { clientRequestId: id, locale: 'en-US' } }, new AbortController().signal, async () => true)).toEqual({ ok: false, code: 'SAVE_UNCERTAIN' }); expect(fetcher).toHaveBeenCalledOnce();
  });
});
