import { describe, expect, it } from 'vitest';
import { admitAssistantFrame } from '../assistant/runtime/frame-admission';
const launch = { tabId: 7, topDocumentId: 'top-1', topUrl: 'https://jobs.example.test/a', frameUrl: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/assistant.html?launch=123' };
const top = { frameId: 0, parentFrameId: -1, documentId: 'top-1', url: launch.topUrl };
const context = { tabId: 7, frameId: 4, documentId: 'child-1', documentUrl: launch.frameUrl };
const sender = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tab: { id: 7 }, frameId: 4, documentId: 'child-1', url: launch.frameUrl };
describe('assistant frame admission', () => {
  it('binds a single exact extension child to its current top document', () => {
    expect(admitAssistantFrame(sender.id, launch, sender, [top], [context], true)).toBe(true);
    for (const bad of [{ ...sender, frameId: 0 }, { ...sender, documentId: 'other' }, { ...sender, tab: { id: 8 } }, { ...sender, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, { ...sender, url: 'https://attacker.invalid' }]) {
      expect(admitAssistantFrame(sender.id, launch, bad, [top], [context], true)).toBe(false);
    }
  });
  it('rejects navigation, duplicate windows, removal and a replaced frame', () => {
    for (const frames of [[], [{ ...top, url: 'https://jobs.example.test/b' }], [{ ...top, documentId: 'top-2' }]]) {
      expect(admitAssistantFrame(sender.id, launch, sender, frames, [context], true)).toBe(false);
    }
    for (const contexts of [[], [context, { ...context, frameId: 5 }], [{ ...context, documentId: 'replacement' }], [{ ...context, tabId: 8 }]]) {
      expect(admitAssistantFrame(sender.id, launch, sender, [top], contexts, true)).toBe(false);
    }
    expect(admitAssistantFrame(sender.id, launch, sender, [top], [context], false)).toBe(false);
  });
});

it('admits the canonical Chrome document after a dynamic resource URL redirect', () => {
  const dynamic = { ...launch, frameUrl: launch.frameUrl.replace(sender.id, '30000000-0000-4000-8000-000000000001') };
  expect(admitAssistantFrame(sender.id, dynamic, sender, [top], [context], true)).toBe(true);
});
