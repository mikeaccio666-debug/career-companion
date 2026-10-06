/**
 * 代填条款、声明与签名（2026-09-23；负责人 2026-09-22 夜的决定）——计划期。
 *
 * 能力位 `sign-on-behalf` 由调用方按「运行时包放行 ∧ 用户在资料页单独同意过」给出。开着：
 *  · 条款／隐私政策同意、属实声明的单个勾选框 → 排进计划（勾上），条目带类别；
 *  · 签名栏 → 档案全名；签名日期栏 → 调用方给的当天日期，按那一栏的掩码写。
 * 关着：这几类一律 MANUAL_ONLY——**包括**被规则认成 fullName 的「签名栏」（从前会被直接填上）。
 * 营销这类混进来的框，开着也不代填。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import type { ApplyFieldKey, ApplyFormDescriptor } from '../src/contracts';

const TERMS = 'By selecting the checkbox, you agree to our Terms and Conditions and Applicant Privacy Policy.';
const ATTEST = 'I certify that the information provided in this application is true and complete.';
// 为营销分享资料：哪一版的同意都不覆盖（2026-09-28 起「营销 + 日后联系」一类只由放行类别组成的混合可以代填，这一句不行）。
const MARKETING = 'I consent to Acme sharing my information with its partners for marketing purposes.';

type Spec =
  | { kind: 'checkbox'; label: string; checked?: boolean }
  | { kind: 'text'; label: string; key?: ApplyFieldKey | null; placeholder?: string; type?: string; value?: string };

function form(specs: readonly Spec[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${specs.map((spec, index) => spec.kind === 'checkbox'
    ? `<label for="f${index}">${spec.label}</label><input type="checkbox" id="f${index}" name="f${index}"${spec.checked ? ' checked' : ''}>`
    : `<label for="f${index}">${spec.label}</label><input type="${spec.type ?? 'text'}" id="f${index}" name="f${index}"${spec.placeholder ? ` placeholder="${spec.placeholder}"` : ''}${spec.value ? ` value="${spec.value}"` : ''}>`).join('')}</form>`;
  const fields = specs.map((spec, index) => {
    const element = document.getElementById(`f${index}`) as HTMLInputElement;
    const common = { element, label: spec.label, required: true, signature: { core: `form/input:${index}`, labelHint: `f${index}` } };
    return spec.kind === 'checkbox'
      ? { ...common, kind: 'choice', key: null, confidence: 0, choice: { control: 'checkbox', options: [{ element, label: spec.label }] } }
      : { ...common, kind: 'text', key: spec.key ?? null, confidence: spec.key ? 1 : 0 };
  });
  return { vendor: 'workday', root: createScanRoot(document.querySelector('form')!, [], []), fields } as never;
}

const PROFILE = { firstName: 'Ada', lastName: 'Lovelace' };

function plan(specs: readonly Spec[], options: { on?: boolean; signingDate?: string; fillEmptyOnly?: boolean; profile?: Record<string, string> } = {}) {
  return buildApplyPlan(form(specs), (options.profile ?? PROFILE) as never, {
    fillEmptyOnly: options.fillEmptyOnly ?? true,
    capabilities: { 'sign-on-behalf': options.on === true },
    ...(options.signingDate === undefined ? {} : { signingDate: options.signingDate }),
  } as never);
}

afterEach(() => { document.body.innerHTML = ''; });

describe('能力位开着（运行时包放行 ∧ 用户同意过）', () => {
  it('条款同意与属实声明 → 勾上，条目带类别；为营销分享资料的框照旧交还本人', () => {
    const result = plan([{ kind: 'checkbox', label: TERMS }, { kind: 'checkbox', label: ATTEST }, { kind: 'checkbox', label: MARKETING }], { on: true });
    expect(result.entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'termsConsent', value: TERMS, signOnBehalf: 'TERMS_CONSENT' }),
      expect.objectContaining({ kind: 'choice', key: 'truthAttestation', value: ATTEST, signOnBehalf: 'TRUTH_ATTESTATION' }),
    ]);
    expect(result.skipped).toEqual([expect.objectContaining({ label: MARKETING, reason: 'MANUAL_ONLY' })]);
  });

  it('签名栏 → 档案全名；签名日期 → 当天，按那一栏的掩码写', () => {
    const result = plan([
      { kind: 'text', label: 'Electronic Signature' },
      { kind: 'text', label: "Today's Date", placeholder: 'MM/DD/YYYY' },
    ], { on: true, signingDate: '2026-09-23' });
    expect(result.entries).toEqual([
      expect.objectContaining({ kind: 'text', key: 'signatureName', value: 'Ada Lovelace', signOnBehalf: 'SIGNATURE_NAME' }),
      expect.objectContaining({ kind: 'text', key: 'signatureDate', value: '09/23/2026', signOnBehalf: 'SIGNATURE_DATE' }),
    ]);
  });

  it('type=date 的签名日期写 ISO；调用方没给日期 → 交还本人', () => {
    expect(plan([{ kind: 'text', label: 'Date Signed', type: 'date' }], { on: true, signingDate: '2026-09-23' }).entries)
      .toEqual([expect.objectContaining({ key: 'signatureDate', value: '2026-09-23' })]);
    expect(plan([{ kind: 'text', label: 'Date Signed', type: 'date' }], { on: true }).skipped)
      .toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
  });

  it('档案里没有姓名 → 签名栏交还本人（不替他编一个名字）', () => {
    const result = plan([{ kind: 'text', label: 'Signature' }], { on: true, profile: {} });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
  });

  it('框已经勾着 / 签名栏已有字 → 不动（只填空的）', () => {
    const result = plan([{ kind: 'checkbox', label: TERMS, checked: true }, { kind: 'text', label: 'Signature', value: 'A. L.' }], { on: true });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(['NOT_EMPTY', 'NOT_EMPTY']);
  });
});

describe('能力位关着（默认）', () => {
  it('条款、声明、签名一律 MANUAL_ONLY', () => {
    const result = plan([
      { kind: 'checkbox', label: TERMS },
      { kind: 'checkbox', label: ATTEST },
      { kind: 'text', label: 'Signature' },
      { kind: 'text', label: "Today's Date" },
    ], { signingDate: '2026-09-23' });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(['MANUAL_ONLY', 'MANUAL_ONLY', 'MANUAL_ONLY', 'MANUAL_ONLY']);
  });

  it('被规则认成 fullName 的签名栏也不填——从前它会被当成姓名直接写上', () => {
    // 不带 electronic 的写法：从前的「电子签名」判据接不住它，Lever／通用规则的 `full name` 又把它认成 fullName。
    const result = plan([{ kind: 'text', label: 'Type your full name as your signature', key: 'fullName' }]);
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
  });
});
