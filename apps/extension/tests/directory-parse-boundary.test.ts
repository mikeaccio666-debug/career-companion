import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

/**
 * Every file allowed to turn a network answer into an object.
 *
 * Each one is a response parser that owns its own contract and refuses a shape
 * it does not know. `profileDirectoryClient` is the newest and the reason this
 * gate exists: its transport hands back branded text on purpose, so that the
 * checking stands in front of the values rather than beside them. Text has no
 * fields, so nobody reads an answer off it by accident — but a deliberate
 * `JSON.parse` somewhere else would walk straight around that, and would not
 * look wrong while doing it.
 *
 * Adding a name here is the deliberate act. Doing it without deciding where the
 * shape check lives is the mistake this refuses to let pass quietly.
 */
const MAY_PARSE: readonly string[] = [
  // Private intake sends every view, stream event and error to its shared validator.
  'assistant/features/intake/owner-intake.ts',
  // Dormant S2 reader: bounded metadata JSON goes straight to the shared
  // parseResumeLibrarySnapshotV1 validator; personal reads retain their owner parser.
  'assistant/features/session/owner-reader.ts',
  'lib/answerMemoryClient.ts',
  // AI 起草开放题（P3-13）：worker 读起草端点的答复，形状交给契约自己的解析器
  // （parseCreateApplicationQuestionDraftsResponseV1，题目 id / requestId 对不上整份不要）。
  'lib/questionDraftClient.ts',
  // AI 代答（2026-09-23）：worker 读 Full AI 规划／改写／次数三个端点的答复，形状全部交给契约自己的解析器
  // （parseFullAiResponse 逐题对回请求、parseFullAiReviseResponse、parseFullAiQuota），对不上整份不要。
  'lib/aiAnswersClient.ts',
  'lib/applicationQuestionClient.ts',
  'lib/authClient.ts',
  'lib/intentVerify.ts',
  // 申请卡片（①）。它读的**不是网络答复**，是宿主页面里的 schema.org ld+json——
  // 比这道闸设想的输入更敌对，因为整段文本由对方控制。形状检查在
  // `readJobPosting`（`@type` 必须恰好是 JobPosting）与 `text()`（非字符串一律
  // 当没有）里；另有三道针对宿主的上限：解析前按字节截、`flatten` 限递归深度、
  // 一页最多看二十份。没有任何值从这里流向宿主控件。
  'lib/jobCardFromPage.ts',
  'lib/pilotUa2ClassificationClient.ts',
  // 手势填写路的结构化档案（P1-8a）：worker 把 V2 快照文本交给契约自己的解析器
  // （parseCandidateProfileSnapshotV2），再由内核投影成集合；解析不过整份丢弃。
  'lib/profileCollectionsProvider.ts',
  // EEO 自我认同答案（2026-09-21）：worker 读它自己的端点，形状在 provider 里判，出去的只有闭集码。
  'lib/eeoAnswersProvider.ts',
  // 代填条款、声明与签名的同意（2026-09-23）：形状交给契约自己的解析器
  // （parseApplicationSigningConsentResponse，形状不对整份作废），出去的只有一个布尔值。
  'lib/signingConsentProvider.ts',
  // 招聘网站账号的本机保险箱（2026-09-28）：解的**不是网络答复**，是它自己用不可导出的密钥加密、存在 storage.local
  // 的那一份记录。AES-GCM 先验过完整性（被改过就解不开），形状再由 `parseVaultRecord` 逐键判；对不上整份当空的、删掉。
  'lib/accountVault.ts',
  'lib/pilotUa5ProfilePayloadClient.ts',
  'lib/profileDirectoryClient.ts',
  // ATS lab only (VIBE_DIST=ats-lab, never in a shippable artifact). The parsed text is a
  // lab command the harness dispatches on the page — `{id, kind, options}` — not a network
  // answer: `parseLabCommand` validates the shape itself and returns null on anything else,
  // and no value read off it ever reaches a host control.
  'lab/labProtocol.ts',
];

/** Comments stripped: a file documenting the rule is not a file breaking it. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'tests') continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) sources(file, out);
    else if (entry.name.endsWith('.ts')) out.push(file);
  }
  return out;
}

describe('turning a network answer into an object is a named privilege', () => {
  it('is exercised only by the response parsers that own a contract', () => {
    const parsing = sources(ROOT)
      .map((file) => file.slice(ROOT.length + 1))
      .filter((path) => /JSON\s*\.\s*parse/u.test(code(readFileSync(join(ROOT, path), 'utf8'))))
      .sort();
    expect(parsing).toEqual([...MAY_PARSE].sort());
  });
});
