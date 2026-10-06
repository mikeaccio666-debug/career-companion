import { afterEach, describe, expect, it, vi } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import type { ApplyFormDescriptor } from '../src/contracts';
import { buildAuditView } from '../src/audit';
import { buildApplyPlan } from '../src/engine';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { mountMyExperience } from './fixtures/workday/myExperience';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * Workday 的简历栏说「收下了」（2026-09-28 adobe.wd5 测试台，连填到第 2 页）。
 *
 * 宿主在 change 里拿走文件、清空文件框（`input[data-automation-id=file-upload-input-ref]` 一直在页面上），约 10 毫秒后
 * 在部件（`attachments-FileUpload`）里列出这一份（`file-upload-item`，名字在 `file-upload-item-name`），约 0.6 秒后给它
 * 挂上「Successfully Uploaded!」（`file-upload-successful`）。我们读不回文件框，从前只看得到文件名：结果是「网站没确认」
 * （FILLED_UNVERIFIED），浮层把必填的简历列进「需要你」，连填停在第 2 页。
 *
 * 规则 `fileUploads` 声明了这个部件怎么说「收下了」：这一次挂上之后多出来的那一项、名字就是这一份、带着这个标记，才算
 * 宿主确认——结果是已核对（FILLED）。没有标记、名字不是这一份、那一项在挂上之前就在，照旧是「网站没确认」。
 * 下面的宿主部件按实测的样子复刻行为（不是 Workday 的代码）。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const FILE_NAME = 'Avery Example Resume.pdf';

interface HostBehavior {
  /** 这么久之后列出一项（名字）；null = 不列。 */
  readonly listAfterMs: number | null;
  /** 列出来的那一项写的名字（缺省就是这一份的名字）。 */
  readonly listedName?: string;
  /** 列出来之后再过这么久挂上「传好了」；null = 不挂（传失败了、还在传）。 */
  readonly successAfterMs: number | null;
}

function item(name: string, success: boolean): HTMLElement {
  const node = document.createElement('div');
  node.setAttribute('data-automation-id', 'file-upload-item');
  node.innerHTML = `<div><div><span></span></div><div>
    <div data-automation-id="file-upload-item-name"></div><div>208.54 KB</div>
    ${success ? '<div data-automation-id="file-upload-successful">Successfully Uploaded!<span></span></div>' : ''}
  </div></div><div><button type="button" data-automation-id="delete-file" title="Delete"><span></span></button></div>`;
  node.querySelector('[data-automation-id="file-upload-item-name"]')!.textContent = name;
  return node;
}

/** 部件里放列表的那一格（部件根下第二个 div）。 */
const list = (): Element => document.querySelector('[data-automation-id="attachments-FileUpload"]')!.lastElementChild!;

function mount(behavior: HostBehavior, before: readonly HTMLElement[] = []): HTMLInputElement {
  mountMyExperience(document, { experiences: 0, educations: 0 });
  // happy-dom 不布局：看得见的「Select files」按钮给一个盒子（简历栏的触发器检查要它）。
  const trigger = document.querySelector<HTMLButtonElement>('[data-automation-id="select-files"]')!;
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
    { width: 120, height: 40, top: 600, left: 400, right: 520, bottom: 640, x: 400, y: 600, toJSON: () => ({}) } as DOMRect,
  );
  list().append(...before);
  const input = document.querySelector<HTMLInputElement>('input[data-automation-id="file-upload-input-ref"]')!;
  input.addEventListener('change', () => {
    const name = behavior.listedName ?? input.files?.[0]?.name ?? '';
    input.files = new DataTransfer().files;
    if (behavior.listAfterMs === null) return;
    setTimeout(() => {
      const listed = item(name, false);
      list().append(listed);
      if (behavior.successAfterMs === null) return;
      setTimeout(() => {
        const mark = document.createElement('div');
        mark.setAttribute('data-automation-id', 'file-upload-successful');
        mark.textContent = 'Successfully Uploaded!';
        listed.querySelector('[data-automation-id="file-upload-item-name"]')!.parentElement!.append(mark);
      }, behavior.successAfterMs);
    }, behavior.listAfterMs);
  }, { once: true });
  return input;
}

function descriptor(rules: unknown = workday): ApplyFormDescriptor {
  const adapter = compileBundledAdapter(rules as never);
  const root = adapter.resolveRoot(document);
  expect(root, '夹具上找不到 applyFlowMyExpPage 锚点').not.toBeNull();
  return { vendor: 'workday', root: root!, fields: [...adapter.scan(root!)], rowScopes: adapter.rowScopes ?? [] };
}

async function attachResume(rules: unknown = workday) {
  const form = descriptor(rules);
  const plan = buildApplyPlan(form, {}, { resumeFileName: FILE_NAME, resumeHostConfirmed: true });
  const only = { ...plan, entries: plan.entries.filter((entry) => entry.kind === 'file') };
  expect(only.entries, '简历栏没进计划').toHaveLength(1);
  const run = runApplyPlan({
    plan: only,
    auth: testAuthority(only.fingerprint, 'fill', [...capabilitiesForKinds(only.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root: form.root,
    policy: { ...testApplyPolicy(), vendors: { ...testApplyPolicy().vendors, workday: true } },
    resolveResumeFile: async () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], FILE_NAME, { type: 'application/pdf' }),
  });
  await vi.runAllTimersAsync();
  const summary = await run;
  return { summary, row: buildAuditView(only, summary.results).rows.find((row) => row.key === 'resumeFile') };
}

describe('规则：fileUploads', () => {
  it('Workday 的简历框带上这种部件的绑定', () => {
    mount({ listAfterMs: null, successAfterMs: null });
    const file = descriptor().fields.find((field) => field.kind === 'file');
    expect(file).toMatchObject({
      kind: 'file',
      upload: {
        containerSelector: '[data-automation-id="attachments-FileUpload"]',
        itemSelector: '[data-automation-id="file-upload-item"]',
        itemNameSelector: '[data-automation-id="file-upload-item-name"]',
        successSelector: '[data-automation-id="file-upload-successful"]',
      },
    });
  });

  it('每一项的键封闭，五个选择器都不能空；缺省、null 都是没有声明', () => {
    const base = structuredClone(workday) as Record<string, unknown> & { fileUploads: Record<string, unknown>[] };
    expect(parseVendorRuleset(base, { unknownFieldKeys: 'reject', unknownTopLevelKeys: 'reject' })).toMatchObject({ ok: true });
    const extra = structuredClone(base);
    extra.fileUploads[0]!['failureSelector'] = '[data-automation-id="file-upload-error"]';
    expect(parseVendorRuleset(extra)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    const empty = structuredClone(base);
    empty.fileUploads[0]!['successSelector'] = ' ';
    expect(parseVendorRuleset(empty)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    const { fileUploads: _drop, ...absent } = base;
    expect(parseVendorRuleset(absent)).toMatchObject({ ok: true, value: { fileUploads: [] } });
    expect(parseVendorRuleset({ ...absent, fileUploads: null })).toMatchObject({ ok: true, value: { fileUploads: [] } });
  });
});

describe('写入：宿主列出这一份、说传好了，才算它确认', () => {
  it('实测的样子（10 毫秒后列出、再过 0.6 秒传好）：已核对，不再是「网站没确认」', async () => {
    vi.useFakeTimers();
    mount({ listAfterMs: 10, successAfterMs: 600 });
    const { summary, row } = await attachResume();
    expect(summary.results[0]).toEqual({ key: 'resumeFile', label: expect.any(String), ok: true });
    expect(row?.status).toBe('FILLED');
  });

  it('列出来了、一直没说传好（传失败、还在传）：照旧「网站没确认」', async () => {
    vi.useFakeTimers();
    mount({ listAfterMs: 10, successAfterMs: null });
    const { summary, row } = await attachResume();
    expect(summary.results[0]).toMatchObject({ ok: true, unverified: true });
    expect(row?.status).toBe('FILLED_UNVERIFIED');
  });

  it('列出来的名字不是这一份：照旧「网站没确认」', async () => {
    vi.useFakeTimers();
    mount({ listAfterMs: 10, listedName: 'Someone Else Resume.pdf', successAfterMs: 600 });
    const { row } = await attachResume();
    expect(row?.status).not.toBe('FILLED');
  });

  it('挂上之前部件里就有同名、传好了的一项，这一次没有多出一项：照旧「网站没确认」', async () => {
    vi.useFakeTimers();
    mount({ listAfterMs: null, successAfterMs: null }, [item(FILE_NAME, true)]);
    const { summary } = await attachResume();
    expect(summary.results[0]).toMatchObject({ ok: true, unverified: true });
  });

  it('反向：规则没有 fileUploads（旧规则）：与从前逐字相同，「网站没确认」', async () => {
    vi.useFakeTimers();
    mount({ listAfterMs: 10, successAfterMs: 600 });
    const { fileUploads: _drop, ...rules } = workday as Record<string, unknown>;
    const { summary } = await attachResume(rules);
    expect(summary.results[0]).toMatchObject({ ok: true, unverified: true });
  });
});
