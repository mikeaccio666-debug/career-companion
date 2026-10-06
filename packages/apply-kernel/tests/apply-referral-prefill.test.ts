import { afterEach, describe, expect, it } from 'vitest';

import { isOtherPersonField, isReferralField, isReferralNameField } from '../src/dict/guards';
import { buildApplyPlan } from '../src/engine';
import type { ApplyFormDescriptor } from '../src/contracts';
import { createScanRoot } from '../src/scanRoot';

/**
 * 推荐人预填（P1-9，2026-09-21 Mike 拍板：只开推荐人姓名，且只取用户亲手存的列表）。
 *
 * 四道闸：能力位放行、这一栏是推荐人**姓名**、申请卡片有公司名、档案里恰好一条推荐到这家。
 * 全过就直接写（2026-09-21 起：那条记录是用户自己存的，存下就是同意）；没过的推荐人栏按
 * OTHER_PERSON 跳过——从前 "Referred by" 不在 OTHER_PERSON 里，会按标签把申请人自己的名字写进去。
 */

function form(label: string, type = 'text'): ApplyFormDescriptor {
  document.body.innerHTML = `<form><label for="f">${label}</label><input id="f" type="${type}" /></form>`;
  const element = document.getElementById('f') as HTMLInputElement;
  return {
    vendor: 'greenhouse',
    root: createScanRoot(document.querySelector('form')!, [], []),
    fields: [{ kind: 'text', element, key: null, label, required: false, confidence: 0, signature: { core: 'form/input:0', labelHint: 'q' } }],
  } as never;
}

const REFERRALS = [
  { name: 'Dana Li', company: 'Acme, Inc.' },
  { name: 'Sam Wu', company: 'Globex' },
];

type Over = Partial<{ capability: boolean; jobCompany: string | undefined; referrals: readonly { name: string; company: string }[] }>;

function planFor(label: string, over: Over = {}) {
  return buildApplyPlan(form(label), {} as never, {
    fillEmptyOnly: false,
    ...((over.capability ?? true) ? { capabilities: { 'set-referral': true } } : {}),
    referrals: over.referrals ?? REFERRALS,
    ...(('jobCompany' in over) ? (over.jobCompany === undefined ? {} : { jobCompany: over.jobCompany }) : { jobCompany: 'ACME' }),
  } as never);
}

/** 「不写」的判据：entries 空，且那一行停在 OTHER_PERSON。 */
function skip(label: string, over: Over = {}) {
  const plan = planFor(label, over);
  expect(plan.entries).toHaveLength(0);
  return plan.skipped[0];
}

function written(label: string, over: Over = {}) {
  const plan = planFor(label, over);
  expect(plan.skipped).toHaveLength(0);
  return plan.entries[0];
}

afterEach(() => { document.body.innerHTML = ''; });

describe('哪些栏算推荐人', () => {
  it('referral / referred by / who referred you / 推荐人 / 内推 算；证明人、紧急联系人不算', () => {
    for (const label of ['Referred by', 'Referral name', 'Who referred you to this role?', 'Employee referral', '推荐人姓名', '内推人']) {
      expect(isReferralField(label), label).toBe(true);
    }
    for (const label of ['Reference name', 'Referee email', 'Emergency contact', 'Preferred name']) {
      expect(isReferralField(label), label).toBe(false);
    }
  });

  it('只有姓名那一栏能预填：邮箱、电话、关系、职位都不算', () => {
    expect(isReferralNameField('Referral name')).toBe(true);
    expect(isReferralNameField('Referred by')).toBe(true);
    for (const label of ['Referral email', 'Referrer phone', 'Relationship to referrer', 'Referrer job title', '推荐人邮箱']) {
      expect(isReferralNameField(label), label).toBe(false);
    }
  });

  it('推荐人仍属于他人信息：证明这条闸没有因为细分而放松', () => {
    expect(isOtherPersonField('推荐人姓名')).toBe(true);
  });
});

describe('四道闸全过才写', () => {
  it('恰好一条推荐到这家 → 直接写姓名，键是 referralName', () => {
    expect(written('Referred by')).toMatchObject({ kind: 'text', key: 'referralName', value: 'Dana Li' });
  });

  it('公司名比对不看大小写、标点与公司后缀', () => {
    expect(written('Referral name', { jobCompany: 'acme' })).toMatchObject({ value: 'Dana Li' });
    expect(written('Referral name', { jobCompany: 'Acme Inc' })).toMatchObject({ value: 'Dana Li' });
    expect(skip('Referral name', { jobCompany: 'Acme Labs' })).toMatchObject({ reason: 'OTHER_PERSON' });
  });

  it('那一栏已经有字：fill-first 不覆盖，报 NOT_EMPTY', () => {
    const descriptor = form('Referred by');
    (document.getElementById('f') as HTMLInputElement).value = 'Someone Else';
    const plan = buildApplyPlan(descriptor, {} as never, {
      capabilities: { 'set-referral': true }, referrals: REFERRALS, jobCompany: 'ACME',
    } as never);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'NOT_EMPTY', key: 'referralName' });
  });

  it('能力位没开 → OTHER_PERSON，没有建议', () => {
    expect(skip('Referred by', { capability: false })).toMatchObject({ reason: 'OTHER_PERSON' });
    expect(skip('Referred by', { capability: false })?.prefill).toBeUndefined();
  });

  it('申请卡片没有公司名 → 不猜', () => {
    expect(skip('Referred by', { jobCompany: undefined })).toMatchObject({ reason: 'OTHER_PERSON' });
  });

  it('这家没有推荐人、或有两条 → 不猜', () => {
    expect(skip('Referred by', { jobCompany: 'Initech' })).toMatchObject({ reason: 'OTHER_PERSON' });
    expect(skip('Referred by', { referrals: [...REFERRALS, { name: 'Lee Park', company: 'Acme' }] })).toMatchObject({ reason: 'OTHER_PERSON' });
  });

  it('推荐人邮箱、电话一律不代填', () => {
    expect(skip('Referral email')).toMatchObject({ reason: 'OTHER_PERSON' });
    expect(skip('Referrer phone number')).toMatchObject({ reason: 'OTHER_PERSON' });
  });
});
