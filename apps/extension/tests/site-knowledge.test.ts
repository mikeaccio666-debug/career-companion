import { describe, expect, it, vi } from 'vitest';

import { loadSiteKnowledge } from '../lib/siteKnowledge';

/**
 * 内容脚本注入后向 worker 要一次站点知识（规则）。2026-10-04 体检 10-6 / 吞掉的错第 1 条：从前要不到就什么都不做、也不再要，
 * 页面加载那一刻后端抖一下，白标与公司自建的表这一整次加载都认不出、浮层不挂，后台一个码都没有。现在：没要到隔一会儿再要
 * 一次（只一次），两次都没要到记一个码；装规则照旧——要到了装要到的，没要到装空表（识别随之 fail closed）。
 */
describe('站点知识', () => {
  const wait = vi.fn(async () => {});

  it('第一次就要到：装上、不记码、不再要', async () => {
    const ask = vi.fn(async () => ({ rules: { greenhouse: {} } }));
    const install = vi.fn(async () => {});
    const codes: string[] = [];
    await expect(loadSiteKnowledge({ ask, install, wait, onDiagnostic: (code) => codes.push(code) })).resolves.toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith({ greenhouse: {} });
    expect(codes).toEqual([]);
  });

  it.each([
    ['worker 没答上（发信被拒）', () => Promise.reject(new Error('Could not establish connection'))],
    ['worker 答了但还没有规则', () => Promise.resolve({ rules: null })],
    ['答复不像样', () => Promise.resolve('junk')],
  ])('%s：等一会儿再要一次，要到了就装，记一个「重试过」', async (_label, first) => {
    const ask = vi.fn().mockImplementationOnce(first).mockResolvedValueOnce({ rules: { lever: {} } });
    const install = vi.fn(async () => {});
    const codes: string[] = [];
    await expect(loadSiteKnowledge({ ask, install, wait, onDiagnostic: (code) => codes.push(code) })).resolves.toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith({ lever: {} });
    expect(codes).toEqual(['SITE_KNOWLEDGE_RETRIED']);
  });

  it('两次都没要到：装空表（fail closed）、记一个码，不再要第三次', async () => {
    const ask = vi.fn(async () => ({ rules: null }));
    const install = vi.fn(async () => {});
    const codes: string[] = [];
    await expect(loadSiteKnowledge({ ask, install, wait, onDiagnostic: (code) => codes.push(code) })).resolves.toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledWith(null);
    expect(codes).toEqual(['SITE_KNOWLEDGE_RETRIED', 'SITE_KNOWLEDGE_UNAVAILABLE']);
  });

  it('装规则本身抛了：不逃逸，照「没要到」记码', async () => {
    const ask = vi.fn(async () => ({ rules: { ashby: {} } }));
    const install = vi.fn(async () => { throw new TypeError('compile'); });
    const codes: string[] = [];
    await expect(loadSiteKnowledge({ ask, install, wait, onDiagnostic: (code) => codes.push(code) })).resolves.toBe(false);
    expect(codes).toEqual(['SITE_KNOWLEDGE_UNAVAILABLE']);
  });
});
