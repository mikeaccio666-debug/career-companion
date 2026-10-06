import { describe, expect, it, vi } from 'vitest';

import { OPEN_MISSION_STATUSES, createDockMissionWorker, createTabMissionBindings } from '../lib/dockMissionWorker';

/**
 * 换了账号（2026-10-04）：worker 按标签页记着「这一页是哪一个任务」（一分钟）、按任务记着材料清单（定制简历叫什么）。
 * 那是上一个人的：真文件服务端按账号把关拿不到，但任务那张脸、简历的文件名还会露出来。会话一变就清掉，下一次按新的人重问。
 */
const PAGE = { canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/1' };
const MISSION = '30000000-0000-4000-8000-000000000001';

describe('换了账号：任务归属与材料清单清掉', () => {
  it('这一页是哪一个任务：清掉之后重新问', async () => {
    const resolve = vi.fn(async () => ({ missionId: MISSION, status: [...OPEN_MISSION_STATUSES][0] }) as never);
    const bindings = createTabMissionBindings({ client: { resolve } });
    expect(await bindings.isBound(7, PAGE)).toBe(true);
    expect(await bindings.isBound(7, PAGE)).toBe(true);
    expect(resolve, '一分钟之内记着').toHaveBeenCalledTimes(1);
    bindings.forgetAll();
    expect(bindings.cached(7)).toBeNull();
    await bindings.isBound(7, PAGE);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('任务的材料清单（定制简历叫什么）：清掉之后重新问', async () => {
    const resolve = vi.fn(async () => ({ missionId: MISSION, status: [...OPEN_MISSION_STATUSES][0] }) as never);
    const bindings = createTabMissionBindings({ client: { resolve } });
    const manifest = vi.fn(async () => ({ resume: { state: 'READY', fileName: 'Alice_Resume.pdf', size: 10 } }) as never);
    const worker = createDockMissionWorker({
      extensionId: 'ext',
      readFrameForms: async () => ({}),
      bindings,
      runs: { begin: vi.fn(), finish: vi.fn(), forgetTab: vi.fn() } as never,
      materials: { manifest, releaseResume: vi.fn(), requestCoverLetter: vi.fn(), coverLetterText: vi.fn() } as never,
      missions: { reportSubmission: vi.fn() } as never,
    });
    expect(await (await worker.resumeSupply(7, PAGE))?.plan()).toEqual({ ok: true, fileName: 'Alice_Resume.pdf', size: 10 });
    await (await worker.resumeSupply(7, PAGE))?.plan();
    expect(manifest).toHaveBeenCalledTimes(1);
    worker.forgetUser();
    bindings.forgetAll();
    await (await worker.resumeSupply(7, PAGE))?.plan();
    expect(manifest).toHaveBeenCalledTimes(2);
  });
});
