// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';
import { dockProgressFromAudit } from '../lib/autofillDockProgress';

const handlers = { onAutofill: () => {}, onOpenEntry: () => {} };
const audit = {
  rows: [{ label: '姓名', required: true, status: 'FILLED' as const },
         { label: '你怎么知道这个职位的？', required: true, status: 'AWAITING_USER' as const }],
  filled: 1, requiredTotal: 2, requiredHandled: 1, needsAttention: 1, blockedByUs: 0,
};

describe('the two progress producers meet the same sheet', () => {
  it('reaches the completion face from the real fill path too', () => {
    // The audit is produced once a fill attempt has settled, so it is a finished
    // run by construction. Marking completion with a field only the other
    // producer sets left this path stuck on the working list forever.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.update(dockProgressFromAudit('fill-1', audit as never));
    expect(handle.sheetFace()).toBe('COMPLETE');
  });
});
