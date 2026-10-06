/**
 * 装完把人带到连接页——判据本身的闸。
 *
 * 2026-09-22 发现：worker 里**一个 `onInstalled` 都没有**。用户装完插件，浏览器停在
 * 原地，没有任何一句话说下一步是回官网登录。商店安装尤其如此：Chrome 只把图标塞进
 * 工具栏，而我们的入口是页面上的浮层，浮层又只在十四个主机上出现——于是新用户装完
 * 之后最可能的经历是「什么都没发生」，然后他以为插件坏了。
 *
 * 把 `shouldOpenConnectOnInstall` 删成 `() => true`，下面第三条与第四条就红。
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import {
  firstRunConnectTab,
  landingAfterConnect,
  parseFirstRunConnectTab,
  shouldOpenConnectOnInstall,
} from '../lib/firstRunConnect';

describe('第一次安装、而且还没连上：开连接页', () => {
  it('商店安装', () => {
    expect(shouldOpenConnectOnInstall({ reason: 'install', connected: false })).toBe(true);
  });
});

describe('其余一概不开', () => {
  // 商店版会自动更新。每次静默更新抢一次焦点是打扰，不是帮助。
  it('版本更新不开', () => {
    expect(shouldOpenConnectOnInstall({ reason: 'update', connected: false })).toBe(false);
  });

  it('Chrome 自身更新、共享模块更新都不开', () => {
    expect(shouldOpenConnectOnInstall({ reason: 'chrome_update', connected: false })).toBe(false);
    expect(shouldOpenConnectOnInstall({ reason: 'shared_module_update', connected: false })).toBe(false);
  });

  // 解压加载的包重新加载时也报 install，那时候会话可能还在；再推去登录一次
  // 既多余，又让人以为自己掉线了。
  it('已经连上就不开', () => {
    expect(shouldOpenConnectOnInstall({ reason: 'install', connected: true })).toBe(false);
  });

  // 浏览器给了个我们没见过的词时，按「不打扰」的一侧倒。
  it('认不出的原因不开', () => {
    expect(shouldOpenConnectOnInstall({ reason: '', connected: false })).toBe(false);
    expect(shouldOpenConnectOnInstall({ reason: 'something_new', connected: false })).toBe(false);
  });
});

/**
 * 连上之后那个标签页去哪（2026-09-23）。
 *
 * 负责人实测：浏览器已登录 argoland.ai 时，装完开的连接页当场连上，门户请我们「开设置页」，
 * 我们照旧把标签页关了——一个标签页闪一下就没了，看起来什么都没发生。装完开的那一页没有
 * 申请页可回，改去资料页；浮层里点的「登录」照旧关掉，回到申请页。
 */
describe('连上之后：装完开的那一页去资料页，别的关掉', () => {
  const NOW = 1_800_000_000_000;

  it('就是装完开的那一页 → 资料页', () => {
    expect(landingAfterConnect(42, firstRunConnectTab(42, NOW), NOW + 5 * 60_000)).toBe('PROFILE');
  });

  it('浮层发起的连接（别的标签页、或者没有记录）→ 关掉', () => {
    expect(landingAfterConnect(7, firstRunConnectTab(42, NOW), NOW)).toBe('CLOSE');
    expect(landingAfterConnect(42, null, NOW)).toBe('CLOSE');
  });

  it('记录过了一小时 → 关掉（那一页早就不是刚装完的那一页了）', () => {
    expect(landingAfterConnect(42, firstRunConnectTab(42, NOW), NOW + 60 * 60_000)).toBe('CLOSE');
  });

  it('storage.session 里读回来的形状不对 → 当没有', () => {
    expect(parseFirstRunConnectTab(firstRunConnectTab(42, NOW))).toEqual({ tabId: 42, expiresAt: NOW + 60 * 60_000 });
    for (const value of [undefined, null, 42, [42], { tabId: '42', expiresAt: NOW }, { tabId: -1, expiresAt: NOW }, { tabId: 1.5, expiresAt: NOW }, { tabId: 42 }]) {
      expect(parseFirstRunConnectTab(value)).toBeNull();
    }
  });

  it('background：装完开的那一页记进 storage.session；门户请「开设置页」时按它决定，不再一律关掉', () => {
    const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
    expect(background).toMatch(/set\(\{ \[FIRST_RUN_CONNECT_TAB_KEY\]: firstRunConnectTab\(tab\.id, Date\.now\(\)\) \}\)/);
    expect(background).toMatch(/kind === 'auth\/open-options'[\s\S]{0,200}settleConnectTab\(sender\.tab\.id\)/);
    expect(background).toMatch(/landingAfterConnect\(tabId, firstRun, Date\.now\(\)\) === 'PROFILE'[\s\S]{0,300}DOCK_PORTAL_PATHS\.PROFILE/);
  });
});
