import { classifySiteSupport } from './siteSupport';
import { dismissSiteNotice, showSiteNotice } from './siteNotice';
import type { KernelPageScan, KernelScanOutcome } from './kernelScanner';

/**
 * Uses the current rescan's gate facts, never the vendor captured when the content
 * script first mounted. This keeps vetoed/challenge/frame pages silent.
 */
export function noticeForRescan(
  outcome: KernelScanOutcome,
  show: typeof showSiteNotice = showSiteNotice,
  dismiss: typeof dismissSiteNotice = dismissSiteNotice,
): KernelPageScan | null {
  const support = classifySiteSupport({
    vendor: outcome.vendor,
    gateRefusal: outcome.refusal,
    formParsed: outcome.scan !== null,
  });
  if (support.shouldExplain && support.guidance) {
    show(support.vendor, support.guidance);
  } else {
    dismiss();
  }
  return outcome.scan;
}
