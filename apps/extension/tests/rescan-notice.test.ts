// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { noticeForRescan } from '../lib/rescanNotice';
import type { KernelScanOutcome } from '../lib/kernelScanner';
import { showSiteNotice, type SiteNoticeHandle } from '../lib/siteNotice';
import type { SiteGuidance } from '../lib/siteSupport';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


function outcome(overrides: Partial<KernelScanOutcome> = {}): KernelScanOutcome {
  return { scan: null, refusal: null, vendor: null, ...overrides };
}

function noticeSpy() {
  const calls: Array<{ vendor: string | null; guidance: SiteGuidance }> = [];
  const show = vi.fn((vendor: never, guidance: never) => {
    calls.push({ vendor: vendor as string | null, guidance: guidance as SiteGuidance });
    return { dismiss: () => {}, shadowRoot: null };
  });
  return { calls, show: show as never };
}

describe('rescan notice gate wiring', () => {
  it.each(['EMPLOYER_CONSOLE', 'CHALLENGE_PAGE', 'YIELDED_TO_FRAME'] as const)(
    'stays silent after %s refusal',
    (refusal) => {
      const { calls, show } = noticeSpy();
      const dismiss = vi.fn();
      expect(noticeForRescan(
        outcome({ refusal, vendor: 'greenhouse' }),
        show,
        dismiss,
      )).toBeNull();
      expect(calls).toEqual([]);
      expect(dismiss).toHaveBeenCalledOnce();
    },
  );

  it('explains a permitted recognized page with no form', () => {
    const { calls, show } = noticeSpy();
    noticeForRescan(outcome({ vendor: 'greenhouse' }), show);
    expect(calls).toEqual([{ vendor: 'greenhouse', guidance: 'NO_FORM_FOUND' }]);
  });

  it('uses the current vendor for a credential-page refusal', () => {
    const { calls, show } = noticeSpy();
    noticeForRescan(outcome({ refusal: 'CREDENTIAL_PAGE', vendor: 'workday' }), show);
    expect(calls).toEqual([{ vendor: 'workday', guidance: 'SIGN_IN_FIRST' }]);
  });

  it('returns a successful scan without showing a notice', () => {
    const { calls, show } = noticeSpy();
    const dismiss = vi.fn();
    const scan = { jobId: '/jobs/1' } as never;
    expect(noticeForRescan(
      outcome({ scan, vendor: 'greenhouse' }),
      show,
      dismiss,
    )).toBe(scan);
    expect(calls).toEqual([]);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'a challenge refusal',
      outcome({ refusal: 'CHALLENGE_PAGE', vendor: 'greenhouse' }),
    ],
    [
      'a successful scan',
      outcome({ scan: { jobId: '/jobs/1' } as never, vendor: 'greenhouse' }),
    ],
  ])('removes a prior no-form notice before %s', (_label, nextOutcome) => {
    const handles: SiteNoticeHandle[] = [];
    const show: typeof showSiteNotice = (vendor, guidance) => {
      const handle = showSiteNotice(vendor, guidance);
      handles.push(handle);
      return handle;
    };
    try {
      noticeForRescan(outcome({ vendor: 'greenhouse' }), show);
      expect(document.querySelector('#edaix-site-notice')).not.toBeNull();

      noticeForRescan(nextOutcome, show);
      expect(document.querySelector('#edaix-site-notice')).toBeNull();
    } finally {
      handles.at(-1)?.dismiss();
    }
  });
});
