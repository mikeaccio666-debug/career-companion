import { APPLICATION_SIGNING_CONSENT_VERSION } from '@edaix/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createSigningReconsent, type SigningReconsentDeps } from '../lib/signingReconsent';

/**
 * 代填授权有了新版本（2026-09-28）：浮层里那张一键更新的卡。要不要请看 worker 带来的判断与本机记下的「暂不」；
 * 同意必须是我们 shadow 里的真实点击，验过才记到 argoland；暂不什么都不改，只是这一版不再请。
 */
const EVENT = {} as MouseEvent;
const ROOT = {} as ShadowRoot;

function harness(over: Partial<SigningReconsentDeps> = {}) {
  const grant = vi.fn(over.grant ?? (async () => ({ ok: true as const, value: true })));
  const remember = vi.fn(over.remember ?? (() => {}));
  const onSaved = vi.fn(over.onSaved ?? (() => {}));
  const reconsent = createSigningReconsent({
    grant,
    verifyGesture: over.verifyGesture ?? (() => true),
    remember,
    onSaved,
  });
  return { reconsent, grant, remember, onSaved };
}

describe('要不要请他更新', () => {
  it('worker 说要请、本机没说过暂不 → 请', () => {
    const { reconsent } = harness();
    expect(reconsent.offered()).toBe(false);
    reconsent.observe(true);
    expect(reconsent.offered()).toBe(true);
  });

  it('本机对这一版说过「暂不」→ 不请；对旧的一版说过的不算', () => {
    const declined = harness().reconsent;
    declined.restoreDeclined(APPLICATION_SIGNING_CONSENT_VERSION);
    declined.observe(true);
    expect(declined.offered()).toBe(false);
    const older = harness().reconsent;
    older.restoreDeclined('application-signing-2026-09-24');
    older.observe(true);
    expect(older.offered()).toBe(true);
  });
});

describe('同意新版本', () => {
  it('真实点击 → 记到 argoland；存成之后不再请，预取的档案作废', async () => {
    const { reconsent, grant, onSaved } = harness();
    reconsent.observe(true);
    expect(await reconsent.accept(EVENT, ROOT)).toBe(true);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(reconsent.offered()).toBe(false);
  });

  it('不是我们 shadow 里的真实点击 → 什么都不发', async () => {
    const { reconsent, grant } = harness({ verifyGesture: () => false });
    reconsent.observe(true);
    expect(await reconsent.accept(EVENT, ROOT)).toBe(false);
    expect(grant).not.toHaveBeenCalled();
    expect(reconsent.offered()).toBe(true);
  });

  it('验点击在任何 await 之前（派发当下同步验）', () => {
    const verify = vi.fn(() => true);
    const { reconsent } = harness({ verifyGesture: verify });
    void reconsent.accept(EVENT, ROOT);
    expect(verify).toHaveBeenCalledWith(EVENT, ROOT);
  });

  it('服务端没存上、答的不是「已同意」或者抛错 → false，卡片留着', async () => {
    for (const grant of [
      async () => ({ ok: false as const }),
      async () => ({ ok: true as const, value: false }),
      async () => { throw new Error('offline'); },
    ]) {
      const { reconsent, onSaved } = harness({ grant });
      reconsent.observe(true);
      expect(await reconsent.accept(EVENT, ROOT)).toBe(false);
      expect(onSaved).not.toHaveBeenCalled();
      expect(reconsent.offered()).toBe(true);
    }
  });
});

describe('暂不', () => {
  it('什么都不发，这一版记在本机、不再请', () => {
    const { reconsent, grant, remember } = harness();
    reconsent.observe(true);
    reconsent.decline();
    expect(grant).not.toHaveBeenCalled();
    expect(remember).toHaveBeenCalledWith(APPLICATION_SIGNING_CONSENT_VERSION);
    expect(reconsent.offered()).toBe(false);
  });
});
