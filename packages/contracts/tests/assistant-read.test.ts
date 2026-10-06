import { describe, expect, it } from 'vitest';
import { parseAssistantReadRequest, parseAssistantReadResponse, parseAssistantPortalLocale, parseAssistantHostAttest, parseAssistantHostAttestation } from '../src/assistantRead';
const id = '10000000-0000-4000-8000-000000000001';
describe('assistant read closed wire', () => {
  it('closes the value-free top-document witness request and response', () => {
    const request = { kind: 'assistant/host-attest-v1', frameUrl: `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/assistant.html?launch=${id}` };
    expect(parseAssistantHostAttest(request)).toEqual(request);
    for (const patch of [{ ownerId: id }, { frameUrl: 'https://attacker.invalid' }, { frameUrl: request.frameUrl + '#extra' }]) {
      expect(parseAssistantHostAttest({ ...request, ...patch })).toBeNull();
    }
    const reply = { kind: 'assistant/host-attestation-v1', present: true };
    expect(parseAssistantHostAttestation(reply)).toEqual(reply);
    expect(parseAssistantHostAttestation({ ...reply, present: 'true' })).toBeNull();
    expect(parseAssistantHostAttestation({ ...reply, documentId: id })).toBeNull();
  });
  it('accepts only enumerated operations and locale values', () => {
    const request = { kind: 'assistant/read-v1', id, operation: 'SESSION' };
    expect(parseAssistantReadRequest(request)).toEqual(request);
    for (const extra of [{ url: 'https://attacker.invalid' }, { ownerId: id }, { token: 'secret' }, { operation: 'SAVE' }]) {
      expect(parseAssistantReadRequest({ ...request, ...extra })).toBeNull();
    }
    expect(parseAssistantReadRequest({ ...request, operation: 'SET_LOCALE', locale: 'zh-CN' })).not.toBeNull();
    expect(parseAssistantReadRequest({ ...request, operation: 'SET_LOCALE', locale: 'zh' })).toBeNull();
    expect(parseAssistantPortalLocale({ kind: 'assistant/portal-locale-v1', locale: 'en-US' })).not.toBeNull();
    expect(parseAssistantPortalLocale({ kind: 'assistant/portal-locale-v1', locale: 'en-US', ownerId: id })).toBeNull();
  });
  it('rejects secret-bearing responses and unknown errors', () => {
    const response = { kind: 'assistant/read-result-v1', id, operation: 'SESSION', ok: true,
      value: { identity: { ownerId: id, generation: 1 }, locale: 'en-US' } };
    expect(parseAssistantReadResponse(response)).toEqual(response);
    expect(parseAssistantReadResponse({ ...response, value: { ...response.value, accessToken: 'secret' } })).toBeNull();
    expect(parseAssistantReadResponse({ ...response, value: { ...response.value, identity: { ownerId: id, generation: -1 } } })).toBeNull();
    expect(parseAssistantReadResponse({ kind: response.kind, id, operation: 'SESSION', ok: false, code: 'anything' })).toBeNull();
  });
});

it('validates private layout bootstrap and dynamic host probe URLs without opening other shapes', () => {
  const response = { kind: 'assistant/read-result-v1', id, operation: 'LAYOUT_CONTEXT', ok: true,
    value: { nonce: id, origin: 'https://host.example.test' } };
  expect(parseAssistantReadResponse(response)).toEqual(response);
  for (const value of [{ ...response.value, nonce: 'invalid' }, { ...response.value, origin: 'https://host.example.test/path' },
    { ...response.value, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { ...response.value, extra: true }]) {
    expect(parseAssistantReadResponse({ ...response, value })).toBeNull();
  }
  expect(parseAssistantHostAttest({ kind: 'assistant/host-attest-v1', frameUrl: `chrome-extension://${id}/assistant.html?launch=${id}` })).not.toBeNull();
});
