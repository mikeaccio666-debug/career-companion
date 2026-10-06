/**
 * 乙档「信息属实」声明：从扫描结果里挑出可代勾的候选。
 *
 * 已生效的 `PD-2026-08-18-IRONCLAD-5-SPLIT` 把这一类规划为逐条放行后可代勾；
 * 产品签字不等于 production 放行，下面的工程闸仍须全部满足。
 * 本文件只做**挑选与本地绑定**，不写入、不点击——写入在
 * `write/setChecked.ts`，且要 `set-attestation` 能力位。它在包内策略里是
 * `false`，并被两条通用 mint 路径结构性排除（C3 放行闸）。
 *
 * ## 挑选是四道串联的筛，不是一条正则
 *
 * 每一道都独立能否掉一个候选。为什么要冗余到这个程度：本仓当前 fail-closed 闭集
 * （密码、验证码、背景调查同意、仲裁协议、信用报告、药检、营销订阅）
 * 一旦被误判成乙档，后果是**替用户签了一份他没读过的授权**，不可逆。
 * 其中密码、背景调查、仲裁与信用／药检授权属于尚未生效的 pending L2-P proposal；
 * 这不改变本文件在批准前必须把整组拒绝的行为。
 * 相对地，误否一个真的属实声明只是让用户多点一下。两边代价不对称，
 * 所以取严的那边。
 *
 *  1. 必须是 checkbox（radio 是单选语义，不在本版范围）
 *  2. 必须过蜜罐守卫
 *  3. `classifyManualOnly` 必须判 `OPT_IN_ELIGIBLE`
 *  4. 必须命中「作证行为 + 已填信息对象 + 真实／准确／完整」三个
 *     正向条件，且**不命中** `CONSENT_GRANT`。只证明已阅读／已收到的法律
 *     acknowledgement 不在乙档可代勾范围。
 *     —— 第 4 道与第 3 道有重叠，但它们的**失效方式不同**：
 *     第 3 道靠分档函数的整体顺序与整句正向语法，第 4 道再直接复核
 *     同一信息属实闭集与 `CONSENT_GRANT`。
 *     后端 Codex 2026-08-18 的评估要求「复合声明或无法确定分类时一律甲档、
 *     fail closed」，这两道就是那句话的落地。
 *
 * ## 长度闸
 *
 * 太短的不像声明（`I agree` 这种单独出现时含义不明），太长的多半是把整张
 * 卡片的文案抓串了。落在闸外一律不选——让用户自己勾，代价是一下点击。
 */

import {
  CONSENT_GRANT,
  classifyManualOnly,
  isHoneypot,
  isTruthfulnessAttestation,
} from './dict/guards';
import type { ApplyFieldDescriptor, FieldSignature, ScanRoot } from './contracts';
import { fieldSignature } from './fieldIdentity';
import { isTrustedScanRoot } from './scanRoot';

/** 一条可代勾的候选。`declarationText` 只用于当前页的本地确认 UI。 */
export interface AttestationCandidate {
  readonly signature: FieldSignature;
  readonly declarationText: string;
}

interface CandidateAuthority {
  readonly element: HTMLInputElement;
  readonly root: ScanRoot;
  readonly releasedText: string;
  readonly signatureCore: string;
}

const candidateAuthorities = new WeakMap<AttestationCandidate, CandidateAuthority>();

/** 太短不像声明；太长多半抓串了整张卡片。 */
const MIN_TEXT = 20;
const MAX_TEXT = 600;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\*$/, '').trim();
}

/** 这个描述符是不是一个我们能勾的 checkbox。 */
function asCheckbox(field: ApplyFieldDescriptor): HTMLInputElement | null {
  const element = field.element as Element;
  if (!(element instanceof HTMLInputElement)) return null;
  return element.type === 'checkbox' ? element : null;
}

/**
 * 从一次扫描里挑出可代勾的「信息属实」声明。
 *
 * 今天 checkbox 一律落 `kind: 'unsupported'`（`dict/controls.ts` 归 choice），
 * 所以候选只可能从那一支里来。**刻意不放宽 `kind` 的判定**——放宽等于给
 * 所有复选框开了一条写入路径，那是另一件事。
 */
export function collectAttestationCandidates(
  fields: readonly ApplyFieldDescriptor[],
  root: ScanRoot,
): readonly AttestationCandidate[] {
  if (!isTrustedScanRoot(root)) return [];
  const out: AttestationCandidate[] = [];

  for (const field of fields) {
    // 乙档候选只能是一道**单独**的复选题：多选项的同名组是普通问题，不是声明。
    if (field.kind !== 'choice' || field.choice.options.length !== 1) continue;

    const element = asCheckbox(field);
    if (!element) continue;
    if (root.isExcluded(element)) continue;

    // 候选的文案只认这个已品牌的 ScanRoot 对当前 DOM 的读取。
    // field.label 仍作为独立对照；两者不同整条拒绝，防止伪造 descriptor。
    const text = normalizeText(root.labelTextFor(element));
    if (text !== normalizeText(field.label)) continue;
    if (text.length < MIN_TEXT || text.length > MAX_TEXT) continue;

    // 第 2 道：蜜罐。误勾一个蜜罐 = 直接告诉宿主我们是机器人。
    //
    // 用 `isHoneypot` 的**完整信号面**，不是只看 label——初版只传了 label，
    // 于是 `name="beecatcher"` 配一段像模像样的声明文案就能过（测试当场抓到）。
    // beecatcher 正是 2026-08-01 在 Workday 实测命中的那个蜜罐名。
    // 信号面与 `engine.ts` 的蜜罐守卫逐项对齐，两边不许漂。
    if (
      isHoneypot({
        text: [
          text,
          element.getAttribute('placeholder'),
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ]
          .filter((v): v is string => Boolean(v))
          .join(' '),
        identities: [
          element.getAttribute('name'),
          element.getAttribute('id'),
          element.getAttribute('data-automation-id'),
          element.getAttribute('data-ui'),
          element.getAttribute('data-qa'),
        ],
      })
    ) {
      continue;
    }

    // 第 3 道：分档。
    //
    // 这里刻意用 `classifyManualOnly`（只看文案）而不是 `isManualOnlyControl`
    // （看 element.type / autocomplete）。后者是 Yiwen 审 PR #20 之后加的结构化
    // 守卫，用来挡「label 写 Email、控件其实是 password」那种形状。
    // 本函数第 1 道已经要求 `element.type === 'checkbox'`，password 进不来——
    // 再加一次结构化检查是**不可达代码**，而本仓不留写好了没有调用方的东西。
    // 若将来放宽第 1 道（比如支持 radio），这里必须改用结构化入口。
    if (classifyManualOnly(text) !== 'OPT_IN_ELIGIBLE') continue;

    // 第 4 道：直接复核正向信息属实闭集与 CONSENT_GRANT。
    // 与第 3 道重叠是**故意的**——它们的失效方式不同，
    // Codex 要求「复合或不确定一律甲档」。
    if (CONSENT_GRANT.test(text)) continue;
    if (!isTruthfulnessAttestation(text)) continue;

    const candidate: AttestationCandidate = Object.freeze({
      signature: field.signature,
      declarationText: text,
    });
    candidateAuthorities.set(candidate, {
      element,
      root,
      releasedText: text,
      signatureCore: field.signature.core,
    });
    out.push(candidate);
  }

  return out;
}

export type AttestationCandidateValidationError =
  | 'ATTESTATION_CANDIDATE_INVALID'
  | 'NOT_A_CHECKBOX'
  | 'DETACHED'
  | 'ATTESTATION_TEXT_CHANGED';

/**
 * Re-read the exact host control through the same trusted ScanRoot immediately
 * before writing. Callers cannot inject a reader, a digest function, an
 * element, or a released snapshot. The original text remains volatile local
 * state and is compared exactly after normalization; no local fingerprint is
 * exposed for a wire message or receipt.
 */
export function revalidateAttestationCandidate(
  candidate: AttestationCandidate,
):
  | { readonly ok: true; readonly element: HTMLInputElement }
  | { readonly ok: false; readonly error: AttestationCandidateValidationError } {
  const authority = candidateAuthorities.get(candidate);
  if (!authority) return { ok: false, error: 'ATTESTATION_CANDIDATE_INVALID' };

  const { element, root, releasedText, signatureCore } = authority;
  if (element.type !== 'checkbox') return { ok: false, error: 'NOT_A_CHECKBOX' };
  if (!element.isConnected) return { ok: false, error: 'DETACHED' };
  if (root.isExcluded(element)) return { ok: false, error: 'ATTESTATION_CANDIDATE_INVALID' };
  if (fieldSignature(element, root).core !== signatureCore) {
    return { ok: false, error: 'ATTESTATION_CANDIDATE_INVALID' };
  }

  const currentText = normalizeText(root.labelTextFor(element));
  if (currentText !== releasedText) {
    return { ok: false, error: 'ATTESTATION_TEXT_CHANGED' };
  }

  // Re-run the irreversible classification gates as a second, independent
  // fail-closed check in case the host changed structural honeypot signals.
  if (
    isHoneypot({
      text: [
        currentText,
        element.getAttribute('placeholder'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ]
        .filter((value): value is string => Boolean(value))
        .join(' '),
      identities: [
        element.getAttribute('name'),
        element.getAttribute('id'),
        element.getAttribute('data-automation-id'),
        element.getAttribute('data-ui'),
        element.getAttribute('data-qa'),
      ],
    }) ||
    classifyManualOnly(currentText) !== 'OPT_IN_ELIGIBLE' ||
    CONSENT_GRANT.test(currentText) ||
    !isTruthfulnessAttestation(currentText)
  ) {
    return { ok: false, error: 'ATTESTATION_CANDIDATE_INVALID' };
  }

  return { ok: true, element };
}
