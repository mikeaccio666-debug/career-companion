import { describe, expect, it } from 'vitest';

import {
  parseBridgeHello,
  parseTabRegistry,
  registerApplicationTab,
  selectExactApplicationTab,
} from '../lib/tabRegistry';

describe('exact application tab registry', () => {
  it('keeps two same-host job paths separate and selects only the exact one', () => {
    let registry = parseTabRegistry(undefined);
    registry = registerApplicationTab(registry, {
      tabId: 7,
      canonicalOrigin: 'https://boards.greenhouse.io',
      pathname: '/acme/jobs/123',
      at: 10,
    });
    registry = registerApplicationTab(registry, {
      tabId: 8,
      canonicalOrigin: 'https://boards.greenhouse.io',
      pathname: '/acme/jobs/456',
      at: 11,
    });

    expect(selectExactApplicationTab(
      Object.values(registry),
      'https://boards.greenhouse.io',
      '/acme/jobs/123',
    )?.tabId).toBe(7);
    expect(selectExactApplicationTab(
      Object.values(registry),
      'https://boards.greenhouse.io',
      '/acme/jobs/999',
    )).toBeNull();
  });

  it('fails closed for duplicate exact candidates instead of guessing the latest tab', () => {
    const entries = [
      { tabId: 7, canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123', at: 10 },
      { tabId: 8, canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123', at: 11 },
    ];
    expect(selectExactApplicationTab(
      entries,
      'https://boards.greenhouse.io',
      '/acme/jobs/123',
    )).toBeNull();
  });

  it('rejects unsafe candidate paths and ignores the legacy origin-only registry shape', () => {
    expect(parseBridgeHello({
      kind: 'bridge/hello',
      origin: 'https://boards.greenhouse.io',
      pathname: '/acme/jobs/123',
    })).toEqual({
      canonicalOrigin: 'https://boards.greenhouse.io',
      pathname: '/acme/jobs/123',
    });
    for (const pathname of [
      '//evil.example/jobs/123',
      '/acme/jobs/../admin',
      '/acme/jobs/%2fadmin',
      '/acme/jobs/123?token=x',
      '/acme/jobs/123#apply',
    ]) {
      expect(parseBridgeHello({
        kind: 'bridge/hello',
        origin: 'https://boards.greenhouse.io',
        pathname,
      })).toBeNull();
    }
    expect(parseTabRegistry({
      'https://boards.greenhouse.io': { tabId: 7, at: 10 },
    })).toEqual({});
  });

  it('白标 B：报到可以带一个 vendorHint，只认厂商清单里的名字，别的多余键照旧拒', () => {
    const hello = { kind: 'bridge/hello', origin: 'https://careers.duolingo.com', pathname: '/jobs/8653419002' };
    expect(parseBridgeHello({ ...hello, vendorHint: 'greenhouse' })).toEqual({
      canonicalOrigin: 'https://careers.duolingo.com', pathname: '/jobs/8653419002', vendorHint: 'greenhouse',
    });
    expect(parseBridgeHello({ ...hello, vendorHint: 'notavendor' })).toBeNull();
    expect(parseBridgeHello({ ...hello, extra: 1 })).toBeNull();
    expect(parseBridgeHello(hello)).not.toHaveProperty('vendorHint');
  });

  it('2026-09-24：报到可以带两个证据位（通用表、JobPosting），只认字面量 true', () => {
    const hello = { kind: 'bridge/hello', origin: 'https://careers.acme.example', pathname: '/apply' };
    expect(parseBridgeHello({ ...hello, genericForm: true, jobPosting: true })).toEqual({
      canonicalOrigin: 'https://careers.acme.example', pathname: '/apply', genericForm: true, jobPosting: true,
    });
    expect(parseBridgeHello({ ...hello, jobPosting: true, vendorHint: 'greenhouse' })).toEqual({
      canonicalOrigin: 'https://careers.acme.example', pathname: '/apply', vendorHint: 'greenhouse', jobPosting: true,
    });
    for (const bad of [false, 'true', 1, null]) {
      expect(parseBridgeHello({ ...hello, genericForm: bad }), `genericForm: ${String(bad)}`).toBeNull();
      expect(parseBridgeHello({ ...hello, jobPosting: bad }), `jobPosting: ${String(bad)}`).toBeNull();
    }
    const plain = parseBridgeHello(hello);
    expect(plain).not.toHaveProperty('genericForm');
    expect(plain).not.toHaveProperty('jobPosting');
    // 必填的三个少一个都不行。
    expect(parseBridgeHello({ kind: 'bridge/hello', origin: hello.origin, genericForm: true })).toBeNull();
  });
});
import { registeredExactPage } from '../lib/tabRegistry';

describe('which page a tab may act as', () => {
  // The profile door hands back answers under the user's token. The only page
  // allowed to ask is the one the tab itself reported — anything else, including
  // the same tab after it navigated, is answered as if it were unknown.
  const registry = parseTabRegistry({
    '7': { tabId: 7, canonicalOrigin: 'https://job-boards.greenhouse.io', pathname: '/acme/jobs/1', at: 1 },
  });
  it('answers the registered page, and only while the sender is still on it', () => {
    expect(registeredExactPage(registry, 7, 'https://job-boards.greenhouse.io/acme/jobs/1')?.tabId).toBe(7);
    expect(registeredExactPage(registry, 7, 'https://job-boards.greenhouse.io/acme/jobs/2'), 'moved').toBeNull();
    expect(registeredExactPage(registry, 8, 'https://job-boards.greenhouse.io/acme/jobs/1'), 'never reported').toBeNull();
    expect(registeredExactPage(registry, 7, 'not a url')).toBeNull();
  });
});
