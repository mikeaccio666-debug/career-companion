// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { documentPathname, keysBesidesDocumentPath, readDocumentPathname, withDocumentPath } from '../lib/documentPath';

/**
 * 单页应用改过地址时 dock 消息多带的那一项（documentPath.ts）。
 *
 * 内容脚本这一侧：地址没改过，消息逐字不变；改过了才带加载时的路径。
 * worker 这一侧：这一项按与 pathname 同一套规则校验，不合法整条作废。
 */

const WORKDAY = 'https://nvidia.wd5.myworkdayjobs.com';
const LOADED = '/en-US/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2024816/apply/applyManually';
const NOW = '/en-US/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2024816/apply';

/** 一个最小的文档替身：当前地址与导航条目上的地址可以不同。 */
function fakeDocument(current: string, navigationEntry: string | null | 'throws'): Document {
  const location = new URL(current);
  return {
    location: { pathname: location.pathname, origin: location.origin },
    defaultView: {
      performance: {
        getEntriesByType: () => {
          if (navigationEntry === 'throws') throw new Error('boom');
          return navigationEntry === null ? [] : [{ name: navigationEntry }];
        },
      },
    },
  } as unknown as Document;
}

describe('documentPathname：这份文档加载时的路径', () => {
  it('被单页应用改过地址 → 交回加载时的那一个', () => {
    expect(documentPathname(fakeDocument(`${WORKDAY}${NOW}`, `${WORKDAY}${LOADED}?source=LinkedIn`))).toBe(LOADED);
  });

  it('没改过 → 就是当前路径', () => {
    expect(documentPathname(fakeDocument(`${WORKDAY}${NOW}`, `${WORKDAY}${NOW}`))).toBe(NOW);
  });

  it.each([
    ['读不到导航条目', null],
    ['读导航条目抛了异常', 'throws'],
    ['导航条目在别的 origin（不该发生，按没改过处理）', `https://evil.example${LOADED}`],
  ] as const)('%s → 退回当前路径，与从前的行为一样', (_why, entry) => {
    expect(documentPathname(fakeDocument(`${WORKDAY}${NOW}`, entry))).toBe(NOW);
  });
});

describe('withDocumentPath：只在改过地址时补上', () => {
  const message = Object.freeze({ kind: 'dock/apply-materials-intent', origin: WORKDAY, pathname: NOW });

  it('改过了 → 多一项 documentPathname，其余逐字不变', () => {
    expect(withDocumentPath(message, fakeDocument(`${WORKDAY}${NOW}`, `${WORKDAY}${LOADED}`)))
      .toEqual({ ...message, documentPathname: LOADED });
  });

  it('没改过 → 原样返回同一个对象', () => {
    expect(withDocumentPath(message, fakeDocument(`${WORKDAY}${NOW}`, `${WORKDAY}${NOW}`))).toBe(message);
  });

  it('创建消息失败（null）→ 仍是 null', () => {
    expect(withDocumentPath(null, fakeDocument(`${WORKDAY}${NOW}`, `${WORKDAY}${LOADED}`))).toBeNull();
  });
});

describe('worker 这一侧', () => {
  it('键集核对时只拿掉这一个可选键', () => {
    expect(keysBesidesDocumentPath({ kind: 1, pathname: 2, documentPathname: 3, extra: 4 })).toEqual(['kind', 'pathname', 'extra']);
  });

  it('没带 → undefined；合法 → 规范化后的路径', () => {
    expect(readDocumentPathname({ pathname: NOW }, WORKDAY)).toBeUndefined();
    expect(readDocumentPathname({ documentPathname: LOADED }, WORKDAY)).toBe(LOADED);
  });

  it.each([
    ['不是字符串', 42],
    ['不以 / 开头', 'apply/applyManually'],
    ['带查询串', `${LOADED}?x=1`],
  ])('%s → null（整条消息作废）', (_why, value) => {
    expect(readDocumentPathname({ documentPathname: value }, WORKDAY)).toBeNull();
  });
});
