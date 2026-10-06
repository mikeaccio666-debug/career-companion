import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApplyPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 宿主在 change 里拿走文件、清空 input，**过一会儿**才把文件名显示出来（2026-09-28 通用路）：
 * Hetzner 的上传栏是 Flow.js（change 里 `addFiles(files)` 之后 `input.value = ''`，传完再显示文件名），
 * Shopify 那张 Ashby 的表同样清空 input 再异步显示。从前只在同一拍里看文件名，于是简历其实已经交给宿主，
 * 我们报 VALUE_COERCED（浮层说「本项未完成」）。
 *
 * 现在：同一拍里读不回来时，等一小会儿看这一栏自己的容器里有没有出现这个文件名——出现了就是宿主收下了
 * （报成功、标 unverified，与同一拍里显示文件名那一种同一个判据）；一直不出现照旧 VALUE_COERCED。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(): HTMLInputElement {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label><input id="first_name" type="text" />
      <div class="field">
        <label for="resume">Resume</label>
        <div class="upload"><input id="resume" type="file" accept=".pdf" /><span class="file_name">Upload file</span></div>
      </div>
    </form>`;
  const resume = document.getElementById('resume') as HTMLInputElement;
  vi.spyOn(resume, 'getBoundingClientRect').mockReturnValue(
    { width: 230, height: 40, top: 100, left: 0, right: 230, bottom: 140, x: 0, y: 100, toJSON: () => ({}) } as DOMRect,
  );
  return resume;
}

async function run() {
  const root = greenhouseAdapter.resolveRoot(document)!;
  const plan = buildApplyPlan(
    { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
    { firstName: 'Avery' },
    { resumeFileName: 'resume.pdf', resumeHostConfirmed: true },
  );
  return runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root,
    policy: testApplyPolicy(),
    resolveResumeFile: async () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'resume.pdf', { type: 'application/pdf' }),
  });
}

/** Flow.js 那样：change 里收下文件、清空 input。 */
function clearOnChange(resume: HTMLInputElement, afterMs: number | null): void {
  resume.addEventListener('change', () => {
    resume.files = new DataTransfer().files;
    if (afterMs === null) return;
    setTimeout(() => {
      resume.parentElement!.querySelector('.file_name')!.textContent = 'resume.pdf (38 KB)';
    }, afterMs);
  }, { once: true });
}

describe('宿主把同一个文件换成它自己的 File 对象', () => {
  /**
   * 2026-09-28 Shopify（Ashby 的表挂在自己的域名上）：change 处理器把 input 的 FileList 换成它自己新建的 File——
   * 同名、同大小、同类型，只是不是我们那个对象。从前按对象同一性判 VALUE_COERCED；lab 在内容脚本里打点实测：
   * 写完同一拍 files=1、same=false。
   */
  it('同名同大小同类型、恰好一个：宿主收下了（unverified）', async () => {
    const resume = mount();
    resume.addEventListener('change', () => {
      const own = resume.files![0]!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([own], own.name, { type: own.type }));
      resume.files = transfer.files;
    }, { once: true });
    const summary = await run();
    expect(summary.results.find((result) => result.key === 'resumeFile')).toMatchObject({ ok: true, unverified: true });
  });

  it('换成了别的文件（改了名）：照旧 VALUE_COERCED', async () => {
    const resume = mount();
    resume.addEventListener('change', () => {
      const own = resume.files![0]!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([own], 'something-else.pdf', { type: own.type }));
      resume.files = transfer.files;
    }, { once: true });
    const summary = await run();
    expect(summary.results.find((result) => result.key === 'resumeFile')).toMatchObject({ ok: false, reason: 'VALUE_COERCED' });
  });
});

describe('宿主异步收下文件', () => {
  it('清空 input、稍后显示文件名：报成功（unverified）', async () => {
    const resume = mount();
    clearOnChange(resume, 150);
    const summary = await run();
    expect(summary.results.find((result) => result.key === 'resumeFile')).toMatchObject({ ok: true, unverified: true });
  });

  it('清空 input、一直不显示文件名：照旧 VALUE_COERCED', async () => {
    const resume = mount();
    clearOnChange(resume, null);
    const summary = await run();
    expect(summary.results.find((result) => result.key === 'resumeFile')).toMatchObject({ ok: false, reason: 'VALUE_COERCED' });
  });
});
