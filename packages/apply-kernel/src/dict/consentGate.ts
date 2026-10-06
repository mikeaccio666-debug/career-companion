/**
 * 数据同意页上替他选哪一项（2026-10-04，负责人 D7）：他资料里的居住国那一项。
 *
 * Jobvite 的「Data Consent」页上，「Location of Residence and Language」的每一项是一份隐私条款，写法各家不同（2026-10-04 在
 * 四家只读抓到的原文）：「Global NinjaOne Candidate Privacy Policy - English」（只有这一项）、「US」「Canadian-French」
 * 「European Economic Area」「Other Areas」、「United States - English」「Canada - French」……、「United States & Other
 * (not in list below)」。
 *
 * 规矩（宁可交还本人，不替他猜一份条款）：
 *  · 点名他居住国的那一项（国名或大写的国家码，与工作授权题同一把尺 `namedWorkRegion`）；同一国几种语言挑英文那一份；
 *  · 列表里没有点名他的国家：只有一项（全球统一的那一份）才选它；不止一项就交还本人——不替他判「Other Areas」算不算他；
 *  · 选中的那一项掺了另外的授权（`consentGateOptionClean`）：不选；
 *  · 资料里没有居住国：只有一项才选。
 */

import { countryNamed } from './regions.ts';
import { consentGateOptionClean } from './signOnBehalf.ts';
import { namedWorkRegion } from './workAuthorization.ts';

/** 下拉里的一项：它在 `<select>` 里的序号与看得见的字（占位那一项不要交进来）。 */
export interface ConsentGateOption {
  readonly index: number;
  readonly text: string;
}

const ENGLISH = /\benglish\b/iu;

/** 替他选哪一项（`ConsentGateOption.index`）；说不准就是 null（交还本人）。 */
export function consentGateResidenceIndex(
  options: readonly ConsentGateOption[],
  residence: string | null | undefined,
): number | null {
  const offered = options.filter((option) => option.text.trim() !== '');
  if (offered.length === 0) return null;
  const only = (candidates: readonly ConsentGateOption[]): number | null =>
    candidates.length === 1 && consentGateOptionClean(candidates[0]!.text) ? candidates[0]!.index : null;
  const text = (residence ?? '').trim();
  const code = text === '' ? null : countryNamed(text);
  if (code !== null) {
    const named = offered.filter((option) => namedWorkRegion(option.text, [code]) === code);
    if (named.length === 1) return only(named);
    if (named.length > 1) return only(named.filter((option) => ENGLISH.test(option.text)));
  }
  return offered.length === 1 ? only(offered) : null;
}
