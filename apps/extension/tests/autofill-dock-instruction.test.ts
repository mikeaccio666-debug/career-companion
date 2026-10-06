import { describe, expect, it } from 'vitest';

import { parseAutofillDockInstruction, parseDockFaceReply } from '../lib/autofillDock';

describe('parseAutofillDockInstruction', () => {
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['no dock field', { kind: 'bridge/hello-ack' }],
    ['an unknown face', { dock: { kind: 'AUTOFILL_EVERYTHING' } }],
    ['guidance without a guidance value', { dock: { kind: 'GUIDANCE' } }],
    ['guidance the classifier never emits', { dock: { kind: 'GUIDANCE', guidance: 'JUST_DO_IT' } }],
    ['unavailable without a reason', { dock: { kind: 'UNAVAILABLE' } }],
    ['unavailable with an invented reason', { dock: { kind: 'UNAVAILABLE', reason: 'BECAUSE' } }],
    ['a face carrying extra keys', { dock: { kind: 'READY', andAlso: 'write' } }],
  ])('refuses %s rather than mounting something it cannot name', (_label, reply) => {
    expect(parseAutofillDockInstruction(reply)).toBeNull();
  });

  it.each([
    [{ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' }],
    [{ kind: 'GUIDANCE', guidance: 'NO_FORM_FOUND' }],
    [{ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' }],
    [{ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }],
    [{ kind: 'READY' }],
  ])('accepts the exact face %o', (dock) => {
    expect(parseAutofillDockInstruction({ dock })).toEqual(dock);
  });

  it('never treats HIDDEN as an instruction to mount', () => {
    expect(parseAutofillDockInstruction({ dock: { kind: 'HIDDEN' } })).toBeNull();
  });
});

// 重问看的是后台的回答本身（2026-10-03）：HIDDEN 是一张脸（这一页什么都不挂），不是「没答上来」。
describe('parseDockFaceReply', () => {
  it('keeps HIDDEN as an answer, so it is never mistaken for no answer', () => {
    expect(parseDockFaceReply({ dock: { kind: 'HIDDEN' } })).toEqual({ kind: 'HIDDEN' });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['no dock field', { kind: 'bridge/hello-ack' }],
    ['HIDDEN carrying extra keys', { dock: { kind: 'HIDDEN', andAlso: 'write' } }],
    ['an unknown face', { dock: { kind: 'AUTOFILL_EVERYTHING' } }],
  ])('still answers null for %s', (_label, reply) => {
    expect(parseDockFaceReply(reply)).toBeNull();
  });
});
