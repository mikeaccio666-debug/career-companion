import { expect, it } from 'vitest';
import { acceptsLayoutConnection } from '../assistant/runtime/layout-handshake';

it('rejects page-preempted connections even with the public launch URL and correct parent origin', () => {
  const parent = {} as Window;
  const context = { nonce: '30000000-0000-4000-8000-000000000001', origin: 'https://host.example.test' };
  const event = { source: parent, origin: context.origin, ports: [{}], data: { type: 'argo-lab-connect', nonce: context.nonce } } as unknown as MessageEvent;
  expect(acceptsLayoutConnection(event, parent, null)).toBe(false);
  for (const nonce of [undefined, '20000000-0000-4000-8000-000000000001']) {
    expect(acceptsLayoutConnection({ ...event, data: { ...event.data, nonce } } as MessageEvent, parent, context)).toBe(false);
  }
  expect(acceptsLayoutConnection({ ...event, origin: 'https://other.example.test' } as MessageEvent, parent, context)).toBe(false);
  expect(acceptsLayoutConnection(event, {} as Window, context)).toBe(false);
  expect(acceptsLayoutConnection({ ...event, ports: [] } as unknown as MessageEvent, parent, context)).toBe(false);
  expect(acceptsLayoutConnection(event, parent, context)).toBe(true);
});
