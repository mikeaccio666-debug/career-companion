import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createDockDiagnostic,
  createDockErrorDiagnostic,
  DOCK_DIAGNOSTIC_CODES,
  errorClassOf,
  parseDockDiagnostic,
  type DockErrorCode,
  type DockPlainCode,
} from '../lib/dockDiagnostic';

/**
 * 内容脚本 → worker 的稳定原因码（2026-10-03 体检 3a-2；2026-10-04 体检 11-2 扩到入口处的异常与吞掉的错）：一轮填写半路抛了、
 * 浮层的按钮抛了、站点知识取不到……从前后台一个码都收不到。只有闭集里的码；异常另带一个闭集里的类名，从不带 message 或 stack；
 * worker 记进诊断环、按码自己的 surface 与种类上报。内容脚本什么时候发，见 apply-content-dock-hygiene.test.ts 与
 * apply-content-run-outcome.test.ts。
 */
describe('dock/diagnostic', () => {
  it('每一个码都解得开：异常那几种带类名，别的不带', () => {
    const boom = new TypeError('Cannot read "x" of https://jobs.lever.co');
    for (const code of DOCK_DIAGNOSTIC_CODES) {
      const asError = parseDockDiagnostic(createDockErrorDiagnostic(code as DockErrorCode, boom));
      const asPlain = parseDockDiagnostic(createDockDiagnostic(code as DockPlainCode));
      // 每个码恰好只有一种造法解得开：表上说它是哪一种就是哪一种。
      expect([asError, asPlain].filter((parsed) => parsed !== null)).toHaveLength(1);
      const parsed = asError ?? asPlain;
      expect(parsed?.code).toBe(code);
      if (parsed?.kind === 'diagnostic') expect(parsed).not.toHaveProperty('errorClass');
      else expect(parsed?.errorClass).toBe('TypeError');
    }
  });

  it('码自己说它从哪来、是哪一种', () => {
    expect(parseDockDiagnostic(createDockErrorDiagnostic('GESTURE_RUN_THREW', new RangeError('x'))))
      .toEqual({ code: 'GESTURE_RUN_THREW', surface: 'apply', kind: 'unhandled_rejection', errorClass: 'RangeError' });
    expect(parseDockDiagnostic(createDockErrorDiagnostic('DOCK_HANDLER_THREW', new TypeError('x'))))
      .toEqual({ code: 'DOCK_HANDLER_THREW', surface: 'dock', kind: 'uncaught_error', errorClass: 'TypeError' });
    expect(parseDockDiagnostic(createDockDiagnostic('SITE_KNOWLEDGE_UNAVAILABLE')))
      .toEqual({ code: 'SITE_KNOWLEDGE_UNAVAILABLE', surface: 'apply', kind: 'diagnostic' });
    expect(parseDockDiagnostic(createDockDiagnostic('DOCK_COPY_FAILED')))
      .toEqual({ code: 'DOCK_COPY_FAILED', surface: 'dock', kind: 'diagnostic' });
  });

  it('消息里只有码与类名：错误消息、页面一样都不带', () => {
    const message = createDockErrorDiagnostic('APPLY_LISTENER_THREW', new Error('Cannot read properties of https://boards.greenhouse.io/acme?token=abc'));
    expect(message).toEqual({ kind: 'dock/diagnostic', code: 'APPLY_LISTENER_THREW', errorClass: 'Error' });
    expect(JSON.stringify(message)).not.toContain('greenhouse');
  });

  it.each([
    [new TypeError('x'), 'TypeError'],
    [new DOMException('x', 'NotAllowedError'), 'NotAllowedError'],
    [new DOMException('x', 'QuotaExceededError'), 'QuotaExceededError'],
    [Object.assign(new Error('x'), { name: 'AcmeCareersWidgetError' }), 'OtherError'],
    [Object.assign(new Error('x'), { name: 'boards.greenhouse.io' }), 'OtherError'],
    ['a thrown string with page text', 'NonError'],
    [undefined, 'NonError'],
    [null, 'NonError'],
    [{ name: 'TypeError' }, 'TypeError'],
  ])('类名只在闭集里：%s → %s', (error, name) => {
    expect(errorClassOf(error)).toBe(name);
  });

  it('连类名都读不出（name 是个会抛的 getter）：OtherError，不再抛', () => {
    expect(errorClassOf(Object.defineProperty({}, 'name', { get: () => { throw new Error('getter'); } }))).toBe('OtherError');
  });

  it('只认闭集里的码、恰好那几个键；该带类名的必须带、不该带的不许带', () => {
    for (const bad of [
      { kind: 'dock/diagnostic', code: 'SOMETHING_ELSE' },
      { kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW', message: 'TypeError: x is undefined' },
      { kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW', url: 'https://boards.greenhouse.io/acme' },
      { kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW' },
      { kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW', errorClass: 'Cannot read x' },
      { kind: 'dock/diagnostic', code: 'GESTURE_RUN_THREW', errorClass: 'TypeError', stack: 'at x' },
      { kind: 'dock/diagnostic', code: 'SITE_KNOWLEDGE_UNAVAILABLE', errorClass: 'TypeError' },
      { kind: 'dock/diagnostics', code: 'GESTURE_RUN_THREW', errorClass: 'TypeError' },
      { code: 'GESTURE_RUN_THREW', errorClass: 'TypeError' },
      null, 'GESTURE_RUN_THREW', ['dock/diagnostic', 'GESTURE_RUN_THREW'],
    ]) {
      expect(parseDockDiagnostic(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('worker 只记我们自己内容脚本发来的、解得开的码（源码形状闸）', () => {
    const background = readFileSync(resolve(__dirname, '..', 'entrypoints', 'background.ts'), 'utf8');
    expect(background).toContain('const diagnostic = parseDockDiagnostic(message);');
    expect(background).toContain('if (diagnostic === null || sender.id !== browser.runtime.id) return;');
  });
});
