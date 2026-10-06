import { parsePilotUa5CompositionRequest, parsePilotUa5RunProjection } from '../src/draft/pilotUa5Certification';
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_CAPABILITIES,
  CHANNEL_ERROR_CODES,
  DISCOVERY_UNAVAILABLE_CODES,
  EXTENSION_CONNECTION_READINESS_STATES,
  NEEDS_USER_INPUT_KINDS,
  RECEIPT_REASON_CODES,
  RUN_STEPS,
  SUBMISSION_STATES,
  parseChannelMessage,
} from '../src/draft/channel';
import {
  PILOT_UA1_DISCOVERY_ERROR_CODE,
  PILOT_UA1_MAX_CONTROLS,
  PILOT_UA1_MAX_OPTION_TEXT_LENGTH,
  PILOT_UA1_MAX_OPTIONS_PER_CONTROL,
  PILOT_UA1_MAX_PATHNAME_LENGTH,
  PILOT_UA1_MAX_TOTAL_SEMANTIC_TEXT_LENGTH,
  parsePilotUa1DiscoveryPacket,
  parsePilotUa1DiscoveryResult,
  type PilotUa1DiscoveryPacket,
  type PilotUa1VisibleControl,
} from '../src/draft/pilotUa1Discovery';
import {
  PILOT_UA2_CLASSIFICATION_ERROR_CODE,
  parsePilotUa2ClassificationRequest,
  parsePilotUa2ClassificationResponse,
  pilotUa2ResponseMatchesRequest,
  type PilotUa2ClassificationRequest,
  type PilotUa2ClassificationSuccess,
} from '../src/draft/pilotUa2Classification';
import {
  PILOT_UA3_CANDIDATE_RULE_ERROR_CODE,
  parsePilotUa3CandidateRule,
  parsePilotUa3CandidateRuleRequest,
  parsePilotUa3CandidateRuleResponse,
  pilotUa3RuleMatchesClassification,
  type PilotUa3CandidateRule,
  type PilotUa3CandidateRuleRequest,
} from '../src/draft/pilotUa3CandidateRule';
import {
  PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE,
  parsePilotUa4TerminalLedger,
  parsePilotUa4WriteAuthorityRequest,
  parsePilotUa4WriteAuthorityResponse,
  pilotUa4AuthorityMatchesLivePage,
  type PilotUa4TerminalLedger,
  type PilotUa4WriteAuthorityRequest,
  type PilotUa4WriteAuthorityResponse,
} from '../src/draft/pilotUa4WriteAuthority';

/**
 * 通道解析器的特征测试（PR #4 评审 Blocking 2/3 与 高1/高3 的锁）：
 * 逐 kind 精确键白名单、闭集成员验证、双向递归走私拒收。
 * ExecutionIntent 的运行时校验不在这里——唯一真相源是稳定包 §5.3 +
 * 扩展侧 intentVerify（旧 draft 形状已废除）。
 */

const ok = (value: unknown) => {
  const parsed = parseChannelMessage(value);
  expect(parsed.ok, `应接受: ${JSON.stringify(value)}`).toBe(true);
};
const rejected = (value: unknown, code = 'CHANNEL_MALFORMED') => {
  expect(parseChannelMessage(value)).toEqual({ ok: false, code });
};

const START = {
  v: 1, kind: 'run/start', clientRequestId: 'req_1',
  missionId: 'm_1', missionStepId: 'ms_1', missionRevision: '8',
};
const DISCOVERY_START = {
  v: 1, kind: 'discovery/start', clientRequestId: 'discovery_1',
  missionId: '11111111-1111-4111-8111-111111111111', missionRevision: '8',
};
const CHANNEL_HELLO = {
  v: 1, kind: 'channel/hello', clientRequestId: 'discovery_1',
  expectedOwnerId: '22222222-2222-4222-8222-222222222222',
  requiredCapabilities: ['DISCOVERY_V1'],
};
const CHANNEL_READY = {
  v: 1, kind: 'channel/ready', clientRequestId: 'discovery_1',
  extensionVersion: '1.0.0', capabilities: ['DISCOVERY_V1'], state: 'READY',
};
const DISCOVERY_AVAILABLE = {
  v: 1, kind: 'discovery/result', clientRequestId: 'discovery_1',
  missionId: '11111111-1111-4111-8111-111111111111', missionRevision: '8', status: 'AVAILABLE',
  canonicalOrigin: 'https://boards.greenhouse.io',
  pathname: '/acme/jobs/123', vendor: 'greenhouse',
  freshUntil: '2026-08-24T16:09:00.000Z',
  fieldKeys: ['email', 'firstName', 'lastName'],
};
const DISCOVERY_UNAVAILABLE = {
  v: 1, kind: 'discovery/result', clientRequestId: 'discovery_1',
  missionId: '11111111-1111-4111-8111-111111111111', missionRevision: '8', status: 'UNAVAILABLE',
  code: 'TAB_UNAVAILABLE',
};
const PROGRESS = { v: 1, kind: 'run/progress', runId: 'r1', jobId: '/j/1', step: 'FILLING', filled: 1, total: 3 };
const RECEIPT_MSG = {
  v: 1, kind: 'run/receipt', runId: 'r1',
  receipt: {
    runId: 'r1', jobId: '/j/1', missionId: 'm_1', missionStepId: 'ms_1',
    filled: 1, total: 2,
    outcomes: [{ key: 'email', ok: true }, { key: 'firstName', ok: false, reason: 'NO_VALUE' }],
    submission: 'NOT_SUBMITTED', finishedAt: 1_800_000_000,
  },
};

describe('信封与版本', () => {
  it('只接受明确支持的版本：更新 → 提示升级；v<1/非数字 → 畸形', () => {
    ok(START);
    rejected({ ...START, v: 2 }, 'CHANNEL_VERSION_TOO_NEW');
    rejected({ ...START, v: 0 });
    rejected({ ...START, v: 0.5 });
    rejected({ ...START, v: '1' });
    rejected(null);
    rejected('run/start');
  });
});

describe('精确键白名单（多一个键整帧拒收）', () => {
  it.each([
    ['run/start', START],
    ['channel/hello', CHANNEL_HELLO],
    ['channel/ready', CHANNEL_READY],
    ['discovery/start', DISCOVERY_START],
    ['discovery/result available', DISCOVERY_AVAILABLE],
    ['discovery/result unavailable', DISCOVERY_UNAVAILABLE],
    ['run/progress', PROGRESS],
    ['run/receipt', RECEIPT_MSG],
    ['run/stopped', { v: 1, kind: 'run/stopped', runId: 'r1', code: 'RUN_ABORTED' }],
    ['run/needs-user-input', { v: 1, kind: 'run/needs-user-input', runId: 'r1', inputRequestId: 'r1_input_1', inputKind: 'CHAT_ANSWER', fieldKey: 'q1' }],
    ['run/accepted', { v: 1, kind: 'run/accepted', clientRequestId: 'req_1', runId: 'r1', missionId: 'm_1', missionStepId: 'ms_1' }],
    ['run/stop', { v: 1, kind: 'run/stop', runId: 'r1' }],
    ['channel/ping', { v: 1, kind: 'channel/ping', seq: 3 }],
  ])('%s：基线合法；附加任意未知键即拒收', (_kind, base) => {
    ok(base);
    rejected({ ...(base as object), extra: 1 });
  });

  it('未知 kind 拒收', () => {
    rejected({ v: 1, kind: 'run/什么', runId: 'r1' });
  });

  it('discovery/result 按状态使用互斥精确键，并拒绝非 canonical 路径', () => {
    const { freshUntil: _freshUntil, ...missingFreshness } = DISCOVERY_AVAILABLE;
    rejected(missingFreshness);
    rejected({ ...DISCOVERY_AVAILABLE, freshUntil: '2026-08-24 16:09:00Z' });
    rejected({ ...DISCOVERY_AVAILABLE, freshUntil: 'not-a-timestamp' });
    rejected({ ...DISCOVERY_AVAILABLE, code: 'TAB_UNAVAILABLE' });
    rejected({ ...DISCOVERY_UNAVAILABLE, pathname: '/acme/jobs/123' });
    rejected({ ...DISCOVERY_AVAILABLE, pathname: 'https://boards.greenhouse.io/acme/jobs/123' });
    rejected({ ...DISCOVERY_AVAILABLE, pathname: '//evil.example/jobs/123' });
    rejected({ ...DISCOVERY_AVAILABLE, fieldKeys: ['firstName', 'firstName'] });
    rejected({ ...DISCOVERY_AVAILABLE, fieldKeys: ['lastName', 'firstName'] });
    rejected({ ...DISCOVERY_AVAILABLE, fieldKeys: ['email', 'ssn'] });
    rejected({ ...DISCOVERY_AVAILABLE, fieldKeys: Array.from({ length: 12 }, (_, index) => `key_${index}`) });
    rejected({ ...DISCOVERY_UNAVAILABLE, code: 'MYSTERY' });
  });

  it('discovery reference 只接受 UUID mission、正十进制 revision 与有界安全关联号', () => {
    rejected({ ...DISCOVERY_START, missionId: 'mission_1' });
    rejected({ ...DISCOVERY_START, missionRevision: '0' });
    rejected({ ...DISCOVERY_START, missionRevision: '08' });
    rejected({ ...DISCOVERY_START, clientRequestId: 'contains space' });
    rejected({ ...DISCOVERY_START, clientRequestId: 'x'.repeat(129) });
    rejected({ ...DISCOVERY_UNAVAILABLE, missionId: 'mission_1' });
  });

  it('authenticated capability/version handshake 只接受闭集能力、canonical owner 与 manifest version', () => {
    rejected({ ...CHANNEL_HELLO, expectedOwnerId: 'owner-guess' });
    rejected({ ...CHANNEL_HELLO, requiredCapabilities: [] });
    // 2026-09-24：能力清单是词汇，不是闭集——形状合法的陌生词被丢掉而不是整条拒；形状不合法的仍拒。
    rejected({ ...CHANNEL_HELLO, requiredCapabilities: ['discovery_v2'] });
    rejected({ ...CHANNEL_HELLO, requiredCapabilities: ['DISCOVERY_V1', 'DISCOVERY_V1'] });
    const futureOnly = parseChannelMessage({ ...CHANNEL_HELLO, requiredCapabilities: ['DISCOVERY_V2'] });
    expect(futureOnly.ok && futureOnly.value.kind === 'channel/hello' && futureOnly.value.requiredCapabilities).toEqual([]);
    rejected({ ...CHANNEL_READY, extensionVersion: 'v1-latest' });
    rejected({ ...CHANNEL_READY, capabilities: [] });
    rejected({ ...CHANNEL_READY, state: 'PROBABLY_READY' });
    ok({ ...CHANNEL_READY, state: 'UNAUTHENTICATED' });
    ok({ ...CHANNEL_READY, state: 'OWNER_MISMATCH' });
    ok({ ...CHANNEL_READY, state: 'INSTALL_UNLINKED' });
    ok({ ...CHANNEL_READY, state: 'AUTHORITY_UNAVAILABLE' });
  });
});

describe('递归走私拒收（双向；别名从宽）', () => {
  it('凭证类与值类键在任意深度出现都整帧拒收', () => {
    for (const key of ['jws', 'jwt', 'token', 'executionLease', 'lease', 'credential', 'password', 'otp', 'cookie']) {
      rejected({ ...START, [key]: 'x' });
    }
    // 扩展→chat 方向同样拒：progress 夹带字段值/凭证。
    rejected({ ...PROGRESS, value: '字段原值' });
    rejected({ ...PROGRESS, password: 'hunter2' });
    rejected({ ...DISCOVERY_AVAILABLE, value: 'ada@example.test' });
    rejected({ ...DISCOVERY_AVAILABLE, selector: '#first_name' });
    // 嵌套深度：receipt 的 outcome 里夹值/标签。
    const smuggledReceipt = JSON.parse(JSON.stringify(RECEIPT_MSG)) as {
      receipt: { outcomes: Record<string, unknown>[] };
    };
    smuggledReceipt.receipt.outcomes[0]!['value'] = 'ada@example.test';
    rejected(smuggledReceipt);
    const labeled = JSON.parse(JSON.stringify(RECEIPT_MSG)) as {
      receipt: { outcomes: Record<string, unknown>[] };
    };
    labeled.receipt.outcomes[1]!['label'] = 'First name';
    rejected(labeled);
  });
});

describe('闭集成员验证（未知码整帧拒收，不折叠不透传）', () => {
  it('step / inputKind / stopped.code / outcome.reason / submission 全部验成员', () => {
    rejected({ ...PROGRESS, step: 'HACKING' });
    rejected({ v: 1, kind: 'run/needs-user-input', runId: 'r1', inputRequestId: 'x', inputKind: 'TELEPATHY' });
    // inputRequestId 必填（T2 关联问题卡↔回答↔下一次 run 的钩子）。
    rejected({ v: 1, kind: 'run/needs-user-input', runId: 'r1', inputKind: 'CHAT_ANSWER' });
    rejected({ v: 1, kind: 'run/stopped', runId: 'r1', code: 'MYSTERY' });
    ok({ v: 1, kind: 'run/stopped', runId: 'r1', code: 'USER_ACTION_REQUIRED' });
    const badReason = JSON.parse(JSON.stringify(RECEIPT_MSG)) as {
      receipt: { outcomes: Record<string, unknown>[] };
    };
    badReason.receipt.outcomes[1]!['reason'] = '自由文本原因';
    rejected(badReason);
    // P4-15：「这题只有你能答」是闭集成员——不登记，带它的回执整帧被拒。
    const userOnly = JSON.parse(JSON.stringify(RECEIPT_MSG)) as {
      receipt: { outcomes: Record<string, unknown>[] };
    };
    userOnly.receipt.outcomes[1]!['reason'] = 'USER_ONLY';
    ok(userOnly);
    const badSubmission = JSON.parse(JSON.stringify(RECEIPT_MSG)) as { receipt: Record<string, unknown> };
    badSubmission.receipt['submission'] = 'SUBMITTED';
    rejected(badSubmission);
  });

  it('计数约束：非负安全整数且 filled <= total；seq 同约束', () => {
    rejected({ ...PROGRESS, filled: -1 });
    rejected({ ...PROGRESS, filled: 5, total: 3 });
    rejected({ ...PROGRESS, total: 1.5 });
    const badCounts = JSON.parse(JSON.stringify(RECEIPT_MSG)) as { receipt: Record<string, unknown> };
    badCounts.receipt['filled'] = 99;
    rejected(badCounts);
    rejected({ v: 1, kind: 'channel/ping', seq: -1 });
  });

  it('闭集常量全部导出（T2 建文案映射的消费面）', () => {
    for (const closedSet of [RUN_STEPS, NEEDS_USER_INPUT_KINDS, CHANNEL_ERROR_CODES, RECEIPT_REASON_CODES, SUBMISSION_STATES, DISCOVERY_UNAVAILABLE_CODES, CHANNEL_CAPABILITIES, EXTENSION_CONNECTION_READINESS_STATES]) {
      expect(closedSet.length).toBeGreaterThan(0);
    }
  });
});

const ua1Digest = (ordinal: number): string => ordinal.toString(16).padStart(64, '0');
const UA1_BINDING = {
  origin: 'https://careers.example.test',
  pathname: '/openings/software-engineer',
  domGeneration: ua1Digest(900),
};
const UA1_CONTROL: PilotUa1VisibleControl = {
  identityDigest: ua1Digest(1),
  role: 'textbox',
  inputType: 'email',
  autocomplete: ['email'],
  required: true,
  accessibleName: 'Email address',
  label: 'Work email',
  legend: null,
  options: [],
  fileAccept: null,
};
const UA1_PACKET: PilotUa1DiscoveryPacket = {
  schemaVersion: 2,
  binding: UA1_BINDING,
  controls: [UA1_CONTROL],
  observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [] },
};

const ua1Rejected = (value: unknown) => {
  expect(parsePilotUa1DiscoveryPacket(value)).toEqual({
    ok: false,
    code: PILOT_UA1_DISCOVERY_ERROR_CODE,
  });
};

describe('UA-1 value-free discovery draft contract', () => {
  it('accepts only the bounded exact-page semantic packet and returns a frozen copy', () => {
    const mutable = JSON.parse(JSON.stringify(UA1_PACKET)) as {
      binding: { pathname: string };
      controls: Array<{ label: string }>;
    };
    const parsed = parsePilotUa1DiscoveryPacket(mutable);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    mutable.binding.pathname = '/changed';
    mutable.controls[0]!.label = 'Changed';
    expect(parsed.value).toEqual(UA1_PACKET);
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.binding)).toBe(true);
    expect(Object.isFrozen(parsed.value.controls)).toBe(true);
    expect(Object.isFrozen(parsed.value.controls[0])).toBe(true);
  });

  it('rejects value/state/files/HTML/screenshot/secret/selector/JS and UA-2 smuggling at every exact-key boundary', () => {
    for (const key of [
      'value', 'currentValue', 'checked', 'selected', 'files', 'html', 'innerHTML',
      'wholePageHtml', 'screenshot', 'secret', 'password', 'cookie', 'token',
      'selector', 'javascript', 'category', 'provenance', 'confidence',
    ]) {
      ua1Rejected({ ...UA1_PACKET, [key]: 'smuggled' });
      ua1Rejected({
        ...UA1_PACKET,
        controls: [{ ...UA1_CONTROL, [key]: 'smuggled' }],
      });
    }
    ua1Rejected({ ...UA1_PACKET, binding: { ...UA1_BINDING, query: '?secret=x' } });
    ua1Rejected({
      ...UA1_PACKET,
      controls: [{
        ...UA1_CONTROL,
        role: 'listbox',
        inputType: 'select-one',
        options: [{
          identityDigest: ua1Digest(2),
          accessibleName: 'Remote',
          selected: true,
        }],
      }],
    });
  });

  it('rejects non-canonical/open-ended identity and semantics', () => {
    ua1Rejected({ ...UA1_PACKET, binding: { ...UA1_BINDING, origin: 'https://careers.example.test/' } });
    ua1Rejected({ ...UA1_PACKET, binding: { ...UA1_BINDING, origin: 'javascript:alert(1)' } });
    ua1Rejected({ ...UA1_PACKET, binding: { ...UA1_BINDING, pathname: '//evil.test/x' } });
    ua1Rejected({ ...UA1_PACKET, binding: { ...UA1_BINDING, pathname: '/x?query=1' } });
    ua1Rejected({
      ...UA1_PACKET,
      binding: { ...UA1_BINDING, pathname: `/${'x'.repeat(PILOT_UA1_MAX_PATHNAME_LENGTH)}` },
    });
    ua1Rejected({ ...UA1_PACKET, binding: { ...UA1_BINDING, domGeneration: 'generation-1' } });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, identityDigest: '#email' }] });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, role: 'application-field' }] });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, inputType: 'hidden' }] });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, autocomplete: ['anything-goes'] }] });
    ua1Rejected({
      ...UA1_PACKET,
      controls: [{
        ...UA1_CONTROL,
        autocomplete: ['home', 'shipping', 'given-name', 'family-name', 'email'],
      }],
    });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, role: null, inputType: null }] });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, label: 'x'.repeat(257) }] });
    ua1Rejected({
      ...UA1_PACKET,
      controls: [{
        ...UA1_CONTROL,
        role: 'listbox',
        inputType: 'select-one',
        options: [{
          identityDigest: ua1Digest(2),
          accessibleName: 'x'.repeat(PILOT_UA1_MAX_OPTION_TEXT_LENGTH + 1),
        }],
      }],
    });
  });

  it('enforces control, per-control option, total option, and aggregate semantic bounds', () => {
    const controls = Array.from({ length: PILOT_UA1_MAX_CONTROLS + 1 }, (_, index) => ({
      ...UA1_CONTROL,
      identityDigest: ua1Digest(index + 1),
    }));
    ua1Rejected({ ...UA1_PACKET, controls });

    const options = Array.from(
      { length: PILOT_UA1_MAX_OPTIONS_PER_CONTROL + 1 },
      (_, index) => ({ identityDigest: ua1Digest(index + 100), accessibleName: `Option ${index}` }),
    );
    ua1Rejected({
      ...UA1_PACKET,
      controls: [{ ...UA1_CONTROL, role: 'listbox', inputType: 'select-one', options }],
    });

    const aggregateOptionControls = Array.from({ length: 9 }, (_, controlIndex) => ({
      ...UA1_CONTROL,
      identityDigest: ua1Digest(controlIndex + 1),
      role: 'listbox',
      inputType: 'select-one',
      options: Array.from({ length: 32 }, (_, optionIndex) => ({
        identityDigest: ua1Digest(1_000 + (controlIndex * 32) + optionIndex),
        accessibleName: `Option ${controlIndex}-${optionIndex}`,
      })),
    }));
    ua1Rejected({ ...UA1_PACKET, controls: aggregateOptionControls });

    const aggregateControls = Array.from({ length: 64 }, (_, index) => ({
      ...UA1_CONTROL,
      identityDigest: ua1Digest(index + 1),
      accessibleName: 'a'.repeat(256),
      label: 'b'.repeat(256),
      legend: 'c'.repeat(256),
      options: [],
    }));
    expect(64 * 3 * 256).toBeGreaterThan(PILOT_UA1_MAX_TOTAL_SEMANTIC_TEXT_LENGTH);
    ua1Rejected({ ...UA1_PACKET, controls: aggregateControls });
  });

  it('accepts only a closed file-accept shape, and only on a file picker', () => {
    const file = { ...UA1_CONTROL, inputType: 'file' as const, fileAccept: 'DOCUMENT' as const };
    expect(parsePilotUa1DiscoveryPacket({ ...UA1_PACKET, controls: [file] }).ok).toBe(true);
    for (const shape of ['DOCUMENT', 'IMAGE', 'ANY', 'OTHER'] as const) {
      expect(parsePilotUa1DiscoveryPacket({
        ...UA1_PACKET,
        controls: [{ ...file, fileAccept: shape }],
      }).ok).toBe(true);
    }
    // The raw accept list is page text and has no place on this wire.
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...file, fileAccept: '.pdf,.docx' }] });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...file, fileAccept: 'RESUME' }] });
    // An accept shape asserts something only a file picker can have.
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, fileAccept: 'DOCUMENT' }] });
    ua1Rejected({ ...UA1_PACKET, controls: [{ ...UA1_CONTROL, fileAccept: undefined }] });
  });

  it('accepts bounded value-free drop accounting and rejects a decoy posing as a question', () => {
    const suppressed = ua1Digest(500);
    expect(parsePilotUa1DiscoveryPacket({
      ...UA1_PACKET,
      observation: { suppressedControls: [suppressed], hiddenNotObservedCount: 3, opaqueBoundaries: [] },
    }).ok).toBe(true);

    // A suppressed control is not an emitted one; overlap would let a decoy be
    // answered as a question.
    ua1Rejected({
      ...UA1_PACKET,
      observation: {
        suppressedControls: [UA1_CONTROL.identityDigest],
        hiddenNotObservedCount: 0, opaqueBoundaries: [],
      },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [suppressed, suppressed], hiddenNotObservedCount: 0, opaqueBoundaries: [] },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: ['#trap'], hiddenNotObservedCount: 0, opaqueBoundaries: [] },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [], hiddenNotObservedCount: -1, opaqueBoundaries: [] },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [], hiddenNotObservedCount: 1.5, opaqueBoundaries: [] },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: {
        suppressedControls: Array.from({ length: 65 }, (_unused, index) => ua1Digest(600 + index)),
        hiddenNotObservedCount: 0,
        opaqueBoundaries: [],
      },
    });
    // Accounting is counts and digests only.
    ua1Rejected({
      ...UA1_PACKET,
      observation: {
        suppressedControls: [],
        hiddenNotObservedCount: 0, opaqueBoundaries: [],
        selector: '#trap',
      },
    });
    ua1Rejected({ ...UA1_PACKET, observation: undefined });
  });

  it('accounts opaque frame boundaries by identity, never by src, and never as a question', () => {
    const boundary = ua1Digest(700);
    const suppressed = ua1Digest(701);
    expect(parsePilotUa1DiscoveryPacket({
      ...UA1_PACKET,
      observation: { suppressedControls: [suppressed], hiddenNotObservedCount: 0, opaqueBoundaries: [boundary] },
    }).ok).toBe(true);
    // The bucket is part of the accounting: a producer that predates it cannot
    // be read as having observed everything, so absence fails closed.
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [], hiddenNotObservedCount: 0 },
    });
    // Wire v2 is BREAKING-L2-T for that reason: a v1 packet is refused outright
    // rather than read as complete.
    ua1Rejected({ ...UA1_PACKET, schemaVersion: 1 });
    // A boundary is neither an emitted control nor a suppressed decoy.
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [UA1_CONTROL.identityDigest] },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [suppressed], hiddenNotObservedCount: 0, opaqueBoundaries: [suppressed] },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [boundary, boundary] },
    });
    // Digests only: no src, host, title or selector.
    ua1Rejected({
      ...UA1_PACKET,
      observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: ['https://widget.invalid/'] },
    });
    ua1Rejected({
      ...UA1_PACKET,
      observation: {
        suppressedControls: [],
        hiddenNotObservedCount: 0,
        opaqueBoundaries: Array.from({ length: 65 }, (_unused, index) => ua1Digest(800 + index)),
      },
    });
  });

  it('rejects duplicate control/option digests and options on non-choice controls', () => {
    ua1Rejected({ ...UA1_PACKET, controls: [UA1_CONTROL, { ...UA1_CONTROL }] });
    ua1Rejected({
      ...UA1_PACKET,
      controls: [{
        ...UA1_CONTROL,
        role: 'listbox',
        inputType: 'select-one',
        options: [
          { identityDigest: ua1Digest(2), accessibleName: 'One' },
          { identityDigest: ua1Digest(2), accessibleName: 'Two' },
        ],
      }],
    });
    ua1Rejected({
      ...UA1_PACKET,
      controls: [
        {
          ...UA1_CONTROL,
          role: 'listbox',
          inputType: 'select-one',
          options: [{ identityDigest: ua1Digest(2), accessibleName: 'One' }],
        },
        { ...UA1_CONTROL, identityDigest: ua1Digest(2) },
      ],
    });
    ua1Rejected({
      ...UA1_PACKET,
      controls: [{
        ...UA1_CONTROL,
        options: [{ identityDigest: ua1Digest(2), accessibleName: 'Not allowed here' }],
      }],
    });
  });

  it('is total on hostile Proxy/accessor/symbol/holey/extra-property containers without invoking getters', () => {
    ua1Rejected(new Proxy({}, { ownKeys: () => { throw new Error('hostile'); } }));
    ua1Rejected({ ...UA1_PACKET, binding: new Proxy({}, {
      getPrototypeOf: () => { throw new Error('hostile'); },
    }) });

    let getterCalls = 0;
    const accessorControl = { ...UA1_CONTROL };
    Object.defineProperty(accessorControl, 'label', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must not run';
      },
    });
    ua1Rejected({ ...UA1_PACKET, controls: [accessorControl] });
    expect(getterCalls).toBe(0);

    const symbolControl = { ...UA1_CONTROL } as typeof UA1_CONTROL & { [key: symbol]: string };
    symbolControl[Symbol('secret')] = 'x';
    ua1Rejected({ ...UA1_PACKET, controls: [symbolControl] });

    const holey = Array(1) as unknown[];
    ua1Rejected({ ...UA1_PACKET, controls: holey });
    const extraArrayKey = [UA1_CONTROL] as typeof UA1_CONTROL[] & { secret?: string };
    extraArrayKey.secret = 'x';
    ua1Rejected({ ...UA1_PACKET, controls: extraArrayKey });
  });

  it('parses only closed, exact-key detection results', () => {
    // The detection receipt carries the UA-1 family version and moved to 2 with
    // the packet; its shape is unchanged.
    const result = {
      schemaVersion: 2,
      binding: UA1_BINDING,
      outcomes: [{ identityDigest: ua1Digest(1), outcome: 'VISIBLE_CONTROL_DETECTED' }],
    };
    expect(parsePilotUa1DiscoveryResult(result)).toEqual({ ok: true, value: result });
    expect(parsePilotUa1DiscoveryResult({
      ...result,
      outcomes: [{ identityDigest: ua1Digest(1), outcome: 'CANONICAL_EMAIL' }],
    })).toEqual({ ok: false, code: PILOT_UA1_DISCOVERY_ERROR_CODE });
    expect(parsePilotUa1DiscoveryResult({ ...result, submit: false })).toEqual({
      ok: false,
      code: PILOT_UA1_DISCOVERY_ERROR_CODE,
    });
    expect(parsePilotUa1DiscoveryResult({
      ...result,
      outcomes: [...result.outcomes, ...result.outcomes],
    })).toEqual({ ok: false, code: PILOT_UA1_DISCOVERY_ERROR_CODE });
  });
});

describe('UA-2 value-free classification draft wire', () => {
  const request: PilotUa2ClassificationRequest = {
    schemaVersion: 1,
    trigger: 'USER_EXACT_PAGE',
    discovery: UA1_PACKET,
  };
  const response: PilotUa2ClassificationSuccess = {
    ok: true,
    schemaVersion: 1,
    binding: UA1_BINDING,
    classifications: [{
      identityDigest: ua1Digest(1),
      kind: 'CANONICAL_FIELD',
      canonicalField: 'EMAIL',
      confidence: 'HIGH',
      provenance: { source: 'AUTOCOMPLETE', semanticDigest: ua1Digest(77) },
      reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
    }],
    constraints: {
      writerAuthority: 'NOT_GRANTED',
      submit: 'HUMAN_ONLY',
      activationState: 'DEFAULT_OFF',
      releaseState: 'NOT_RELEASED',
    },
  };

  it('accepts only an explicit exact-page trigger plus the canonical UA-1 packet', () => {
    expect(parsePilotUa2ClassificationRequest(request)).toEqual({ ok: true, value: request });
    expect(parsePilotUa2ClassificationRequest({ ...request, trigger: 'BACKGROUND' })).toEqual({
      ok: false,
      code: PILOT_UA2_CLASSIFICATION_ERROR_CODE,
    });
    expect(parsePilotUa2ClassificationRequest({ ...request, selector: '#email' })).toEqual({
      ok: false,
      code: PILOT_UA2_CLASSIFICATION_ERROR_CODE,
    });
    expect(parsePilotUa2ClassificationRequest({
      ...request,
      discovery: { ...UA1_PACKET, controls: [{ ...UA1_CONTROL, value: 'secret' }] },
    })).toEqual({ ok: false, code: PILOT_UA2_CLASSIFICATION_ERROR_CODE });
  });

  it('accepts a value-free closed classification and locks the no-write boundary', () => {
    expect(parsePilotUa2ClassificationResponse(response)).toEqual({ ok: true, value: response });
    expect(pilotUa2ResponseMatchesRequest(request, response)).toBe(true);
    expect(JSON.stringify(response)).not.toContain('Work email');
    expect(JSON.stringify(response)).not.toContain('value');

    for (const mutation of [
      { ...response, submit: false },
      { ...response, constraints: { ...response.constraints, submit: 'AUTOMATIC' } },
      { ...response, classifications: [{ ...response.classifications[0], value: 'secret' }] },
      { ...response, classifications: [{ ...response.classifications[0], kind: 'UNSUPPORTED' }] },
      { ...response, classifications: [{ ...response.classifications[0], reasonCode: 'GENERIC_UNSUPPORTED' }] },
    ]) {
      expect(parsePilotUa2ClassificationResponse(mutation)).toEqual({
        ok: false,
        code: PILOT_UA2_CLASSIFICATION_ERROR_CODE,
      });
    }
  });

  it('rejects missing, duplicate, foreign and reordered control dispositions', () => {
    expect(pilotUa2ResponseMatchesRequest(request, { ...response, classifications: [] })).toBe(false);
    expect(pilotUa2ResponseMatchesRequest(request, {
      ...response,
      classifications: [...response.classifications, ...response.classifications],
    })).toBe(false);
    expect(pilotUa2ResponseMatchesRequest(request, {
      ...response,
      classifications: [{ ...response.classifications[0], identityDigest: ua1Digest(2) }],
    })).toBe(false);
    expect(pilotUa2ResponseMatchesRequest(request, {
      ...response,
      binding: { ...UA1_BINDING, domGeneration: ua1Digest(901) },
    })).toBe(false);
  });

  it('parses only stable closed failure results and remains total on hostile values', () => {
    for (const code of [
      'PILOT_CAPABILITY_DISABLED',
      'PILOT_CLASSIFICATION_INPUT_INVALID',
      'PILOT_CLASSIFICATION_UNAVAILABLE',
      'PILOT_TARGET_DRIFT',
    ]) {
      expect(parsePilotUa2ClassificationResponse({ ok: false, schemaVersion: 1, code })).toEqual({
        ok: true,
        value: { ok: false, schemaVersion: 1, code },
      });
    }
    expect(parsePilotUa2ClassificationResponse({ ok: false, schemaVersion: 1, code: 'MODEL SAID NO' }))
      .toEqual({ ok: false, code: PILOT_UA2_CLASSIFICATION_ERROR_CODE });
    expect(parsePilotUa2ClassificationResponse(new Proxy({}, {
      ownKeys: () => { throw new Error('hostile'); },
    }))).toEqual({ ok: false, code: PILOT_UA2_CLASSIFICATION_ERROR_CODE });
  });
});

describe('UA-3 exact-page ephemeral candidate-rule draft wire', () => {
  const classification: PilotUa2ClassificationSuccess = {
    ok: true,
    schemaVersion: 1,
    binding: UA1_BINDING,
    classifications: [{
      identityDigest: ua1Digest(1),
      kind: 'CANONICAL_FIELD',
      canonicalField: 'EMAIL',
      confidence: 'HIGH',
      provenance: { source: 'AUTOCOMPLETE', semanticDigest: ua1Digest(77) },
      reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
    }],
    constraints: {
      writerAuthority: 'NOT_GRANTED',
      submit: 'HUMAN_ONLY',
      activationState: 'DEFAULT_OFF',
      releaseState: 'NOT_RELEASED',
    },
  };
  const request: PilotUa3CandidateRuleRequest = {
    schemaVersion: 1,
    trigger: 'USER_EXACT_PAGE',
    classification,
  };
  const rule: PilotUa3CandidateRule = {
    schemaVersion: 1,
    kind: 'EPHEMERAL_PAGE_CANDIDATE',
    binding: UA1_BINDING,
    pageIdentityDigest: ua1Digest(88),
    issuedAtMs: 1_800_000_000_000,
    expiresAtMs: 1_800_000_030_000,
    classifications: classification.classifications,
    constraints: {
      remoteCode: 'FORBIDDEN',
      automaticPublication: 'FORBIDDEN',
      writerAuthority: 'NOT_GRANTED',
      submit: 'HUMAN_ONLY',
      activationState: 'DEFAULT_OFF',
      releaseState: 'NOT_RELEASED',
    },
  };

  it('accepts only the exact UA-2 success under the explicit user-page trigger', () => {
    expect(parsePilotUa3CandidateRuleRequest(request)).toEqual({ ok: true, value: request });
    expect(parsePilotUa3CandidateRuleRequest({ ...request, trigger: 'BACKGROUND' })).toEqual({
      ok: false,
      code: PILOT_UA3_CANDIDATE_RULE_ERROR_CODE,
    });
    expect(parsePilotUa3CandidateRuleRequest({
      ...request,
      classification: { ...classification, ok: false, code: 'PILOT_CLASSIFICATION_UNAVAILABLE' },
    })).toEqual({ ok: false, code: PILOT_UA3_CANDIDATE_RULE_ERROR_CODE });
  });

  it('accepts a bounded JSON candidate bound to page, DOM generation and every control identity', () => {
    expect(parsePilotUa3CandidateRule(rule)).toEqual({ ok: true, value: rule });
    expect(pilotUa3RuleMatchesClassification(rule, classification)).toBe(true);
    expect(parsePilotUa3CandidateRuleResponse({ ok: true, schemaVersion: 1, rule })).toEqual({
      ok: true,
      value: { ok: true, schemaVersion: 1, rule },
    });
  });

  it('rejects selectors, executable text, write plans, automatic publication and oversized lifetime', () => {
    for (const mutation of [
      { ...rule, selector: '#email' },
      { ...rule, javascript: 'return document.forms[0]' },
      { ...rule, writePlan: [{ value: 'secret' }] },
      { ...rule, constraints: { ...rule.constraints, automaticPublication: 'ALLOWED' } },
      { ...rule, constraints: { ...rule.constraints, writerAuthority: 'GRANTED' } },
      { ...rule, expiresAtMs: rule.issuedAtMs + 60_001 },
    ]) {
      expect(parsePilotUa3CandidateRule(mutation)).toEqual({
        ok: false,
        code: PILOT_UA3_CANDIDATE_RULE_ERROR_CODE,
      });
    }
    expect(JSON.stringify(rule)).not.toMatch(/selector|javascript|writePlan|value/i);
  });

  it('fails closed on binding, semantic and control-identity drift or hostile containers', () => {
    expect(pilotUa3RuleMatchesClassification(rule, {
      ...classification,
      binding: { ...classification.binding, domGeneration: ua1Digest(999) },
    })).toBe(false);
    expect(pilotUa3RuleMatchesClassification(rule, {
      ...classification,
      classifications: [{ ...classification.classifications[0], identityDigest: ua1Digest(2) }],
    })).toBe(false);
    expect(pilotUa3RuleMatchesClassification(rule, {
      ...classification,
      classifications: [{
        ...classification.classifications[0],
        provenance: { ...classification.classifications[0]!.provenance, semanticDigest: ua1Digest(3) },
      }],
    })).toBe(false);
    expect(parsePilotUa3CandidateRule(new Proxy({}, {
      ownKeys: () => { throw new Error('hostile'); },
    }))).toEqual({ ok: false, code: PILOT_UA3_CANDIDATE_RULE_ERROR_CODE });
  });
});

describe('UA-4 exact-page write authority and terminal ledger draft wire', () => {
  const candidateRule: PilotUa3CandidateRule = {
    schemaVersion: 1,
    kind: 'EPHEMERAL_PAGE_CANDIDATE',
    binding: UA1_BINDING,
    pageIdentityDigest: ua1Digest(88),
    issuedAtMs: 1_800_000_000_000,
    expiresAtMs: 1_800_000_030_000,
    classifications: [{
      identityDigest: ua1Digest(1),
      kind: 'CANONICAL_FIELD',
      canonicalField: 'EMAIL',
      confidence: 'HIGH',
      provenance: { source: 'AUTOCOMPLETE', semanticDigest: ua1Digest(77) },
      reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
    }],
    constraints: {
      remoteCode: 'FORBIDDEN',
      automaticPublication: 'FORBIDDEN',
      writerAuthority: 'NOT_GRANTED',
      submit: 'HUMAN_ONLY',
      activationState: 'DEFAULT_OFF',
      releaseState: 'NOT_RELEASED',
    },
  };
  const request: PilotUa4WriteAuthorityRequest = {
    schemaVersion: 1,
    trigger: 'USER_EXACT_PAGE',
    candidateRule,
    currentBinding: UA1_BINDING,
    currentControlIdentityDigests: [ua1Digest(1)],
    questions: [{
      questionId: 'question.email',
      controlKind: 'TEXT',
      identityDigests: [ua1Digest(1)],
      required: true,
      optionsIncomplete: false,
    }],
  };
  const response: PilotUa4WriteAuthorityResponse = {
    ok: true,
    schemaVersion: 1,
    authority: {
      authorityId: ua1Digest(99),
      binding: UA1_BINDING,
      pageIdentityDigest: candidateRule.pageIdentityDigest,
      observedControlIdentityDigests: [ua1Digest(1)],
      expiresAtMs: candidateRule.expiresAtMs,
      questionAuthorizations: [{
        questionId: 'question.email',
        controlKind: 'TEXT',
        identityDigests: [ua1Digest(1)],
        required: true,
        answerAuthority: 'PROFILE_CONFIRMED',
        answerDigest: ua1Digest(91),
      }],
      blockedQuestions: [],
      constraints: {
        exactTargetBinding: 'REQUIRED',
        semanticReadback: 'REQUIRED',
        hostValidation: 'REQUIRED',
        lateRecheck: 'REQUIRED',
        undo: 'REQUIRED',
        submit: 'FORBIDDEN',
        activationState: 'DEFAULT_OFF',
        releaseState: 'NOT_RELEASED',
      },
    },
  };

  it('accepts only value-free, exact-page, provenance-bound writer requests and authority', () => {
    expect(parsePilotUa4WriteAuthorityRequest(request)).toEqual({ ok: true, value: request });
    expect(parsePilotUa4WriteAuthorityResponse(response)).toEqual({ ok: true, value: response });
    expect(pilotUa4AuthorityMatchesLivePage(
      response.authority,
      UA1_BINDING,
      [ua1Digest(1)],
      1_800_000_010_000,
    )).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/answerValue|selector|javascript|submitAction/i);
  });

  /**
   * `answerDigest` on a request is deprecated input kept for older callers. It
   * is not caller authority: the parser takes it, checks it is well formed, and
   * drops it, so nothing downstream can read a caller's binding.
   */
  it('accepts an older caller\'s deprecated answerDigest and carries none of it forward', () => {
    const legacy = {
      ...request,
      questions: [{ ...request.questions[0], answerDigest: ua1Digest(91) }],
    };
    const parsed = parsePilotUa4WriteAuthorityRequest(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The request parses, and the parsed question is byte-identical to one sent
    // without the field -- there is no answerDigest left to read.
    expect(parsed.value.questions[0]).toEqual(request.questions[0]);
    expect('answerDigest' in (parsed.value.questions[0] as object)).toBe(false);
    expect(JSON.stringify(parsed.value)).not.toContain(ua1Digest(91));
    // A new caller omits it, and gets the same parsed request.
    expect(parsePilotUa4WriteAuthorityRequest(request)).toEqual(parsed);
  });

  it('still refuses a malformed deprecated answerDigest, exactly as before', () => {
    for (const malformed of ['not-a-digest', '', 7, null, ua1Digest(1).slice(0, 63)]) {
      expect(parsePilotUa4WriteAuthorityRequest({
        ...request,
        questions: [{ ...request.questions[0], answerDigest: malformed }],
      })).toEqual({ ok: false, code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE });
    }
  });

  it('keeps incomplete option membership local and rejects smuggled values or target drift', () => {
    expect(parsePilotUa4WriteAuthorityRequest({
      ...request,
      questions: [{ ...request.questions[0], answerValue: 'private@example.test' }],
    })).toEqual({ ok: false, code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE });
    expect(parsePilotUa4WriteAuthorityRequest({
      ...request,
      questions: [{ ...request.questions[0], optionsIncomplete: 'false' }],
    })).toEqual({ ok: false, code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE });
    expect(pilotUa4AuthorityMatchesLivePage(
      response.authority,
      { ...UA1_BINDING, domGeneration: ua1Digest(901) },
      [ua1Digest(1)],
      1_800_000_010_000,
    )).toBe(false);
  });

  it('owns the complete question denominator and rejects silent omissions or sentinel coverage', () => {
    const ledger: PilotUa4TerminalLedger = {
      schemaVersion: 2,
      binding: UA1_BINDING,
      discoveryComplete: true,
      questions: [
        { questionId: 'question.email', required: true },
        { questionId: 'question.phone', required: true },
      ],
      dispositions: [
        {
          questionId: 'question.email',
          disposition: {
            state: 'FILLED',
            semanticReadback: 'HOST_ACCEPTED',
            lateRecheck: 'STABLE',
            undo: 'OWNED',
          },
        },
        {
          questionId: 'question.phone',
          disposition: { state: 'POLICY_BLOCKED', reason: 'OPTIONS_INCOMPLETE' },
        },
      ],
      unobservedRegions: [],
      summary: {
        observableQuestions: 2,
        requiredQuestions: 2,
        terminalQuestions: 2,
        terminalRequiredQuestions: 2,
        requiredFieldFinalDispositionCoverage: 100,
        unobservedRegions: 0,
      },
    };
    expect(parsePilotUa4TerminalLedger(ledger)).toEqual({ ok: true, value: ledger });
    expect(parsePilotUa4TerminalLedger({
      ...ledger,
      dispositions: ledger.dispositions.slice(0, 1),
    })).toEqual({ ok: false, code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE });
    expect(parsePilotUa4TerminalLedger({
      ...ledger,
      summary: { ...ledger.summary, requiredFieldFinalDispositionCoverage: 100 },
      dispositions: [{
        questionId: 'question.email',
        disposition: {
          state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
        },
      }],
    })).toEqual({ ok: false, code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE });
  });

  it('requires precise reachability evidence whenever discovery is incomplete', () => {
    const ledger: PilotUa4TerminalLedger = {
      schemaVersion: 2,
      binding: UA1_BINDING,
      discoveryComplete: false,
      questions: [{ questionId: 'surface.cross-origin-frame', required: true }],
      dispositions: [{
        questionId: 'surface.cross-origin-frame',
        disposition: {
          state: 'DISCOVERY_INCOMPLETE',
          reachability: 'CROSS_ORIGIN_IFRAME_UNREACHABLE',
        },
      }],
      unobservedRegions: [],
      summary: {
        observableQuestions: 1,
        requiredQuestions: 1,
        terminalQuestions: 1,
        terminalRequiredQuestions: 1,
        requiredFieldFinalDispositionCoverage: 100,
        unobservedRegions: 0,
      },
    };
    expect(parsePilotUa4TerminalLedger(ledger)).toEqual({ ok: true, value: ledger });
    expect(parsePilotUa4TerminalLedger({ ...ledger, discoveryComplete: true })).toEqual({
      ok: false,
      code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE,
    });
  });

  it('accepts a precise generic human-action manual disposition without inventing a subtype', () => {
    const ledger: PilotUa4TerminalLedger = {
      schemaVersion: 2,
      binding: UA1_BINDING,
      discoveryComplete: true,
      questions: [{ questionId: 'question.human-action', required: true }],
      dispositions: [{
        questionId: 'question.human-action',
        disposition: { state: 'MANUAL_REQUIRED', reason: 'HUMAN_ACTION' },
      }],
      unobservedRegions: [],
      summary: {
        observableQuestions: 1,
        requiredQuestions: 1,
        terminalQuestions: 1,
        terminalRequiredQuestions: 1,
        requiredFieldFinalDispositionCoverage: 100,
        unobservedRegions: 0,
      },
    };
    expect(parsePilotUa4TerminalLedger(ledger)).toEqual({ ok: true, value: ledger });
  });

  it('expresses an unobserved region apart from the questions and refuses a whole-page claim over it', () => {
    const region = ua1Digest(700);
    const filled = {
      state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: 'OWNED',
    } as const;
    const ledger: PilotUa4TerminalLedger = {
      schemaVersion: 2,
      binding: UA1_BINDING,
      discoveryComplete: false,
      questions: [{ questionId: 'question.email', required: true }],
      dispositions: [{ questionId: 'question.email', disposition: filled }],
      unobservedRegions: [{ regionId: region, reason: 'FRAME_NOT_OBSERVED' }],
      summary: {
        observableQuestions: 1,
        requiredQuestions: 1,
        terminalQuestions: 1,
        terminalRequiredQuestions: 1,
        // Over the observed question only -- the region is not in this denominator.
        requiredFieldFinalDispositionCoverage: 100,
        unobservedRegions: 1,
      },
    };
    expect(parsePilotUa4TerminalLedger(ledger)).toEqual({ ok: true, value: ledger });
    const rejected = (candidate: unknown) => {
      expect(parsePilotUa4TerminalLedger(candidate)).toEqual({
        ok: false, code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE,
      });
    };
    // A region and a whole-page completion cannot both be claimed.
    rejected({ ...ledger, discoveryComplete: true });
    // The count is recomputed, not trusted.
    rejected({ ...ledger, summary: { ...ledger.summary, unobservedRegions: 0 } });
    // Not a question: it may not shadow one, and it takes no terminal.
    rejected({ ...ledger, unobservedRegions: [{ regionId: 'question.email', reason: 'FRAME_NOT_OBSERVED' }] });
    rejected({ ...ledger, unobservedRegions: [...ledger.unobservedRegions, ...ledger.unobservedRegions], summary: { ...ledger.summary, unobservedRegions: 2 } });
    // The reason is a closed neutral set; an origin claim the scan never checked is not in it.
    rejected({ ...ledger, unobservedRegions: [{ regionId: region, reason: 'CROSS_ORIGIN_IFRAME_UNREACHABLE' }] });
    // Identity only -- no src, host, title or selector rides along.
    rejected({ ...ledger, unobservedRegions: [{ regionId: region, reason: 'FRAME_NOT_OBSERVED', src: 'https://widget.invalid/' }] });
    rejected({ ...ledger, unobservedRegions: [{ regionId: 'iframe#widget', reason: 'FRAME_NOT_OBSERVED' }] });
    rejected({
      ...ledger,
      unobservedRegions: Array.from({ length: 65 }, (_unused, index) => ({
        regionId: ua1Digest(800 + index), reason: 'FRAME_NOT_OBSERVED',
      })),
      summary: { ...ledger.summary, unobservedRegions: 65 },
    });
    // The section is required: a v1 ledger, or a v2 shape without it, cannot be
    // read as having nothing unobserved (BREAKING-L2-T, delivered atomically).
    const { unobservedRegions: _regions, ...withoutRegions } = ledger;
    rejected({ ...withoutRegions, discoveryComplete: true, summary: { ...ledger.summary, unobservedRegions: 0 } });
    rejected({ ...ledger, schemaVersion: 1 });
    // And with no region, an empty section still parses -- and only with the claim intact.
    const none = {
      ...ledger, discoveryComplete: true, unobservedRegions: [],
      summary: { ...ledger.summary, unobservedRegions: 0 },
    };
    expect(parsePilotUa4TerminalLedger(none)).toEqual({ ok: true, value: none });
    rejected({ ...none, discoveryComplete: false });
  });
});

describe('pilot UA-5 composition wire', () => {
  const sha = (seed: string): string => seed.repeat(64).slice(0, 64);
  const binding = Object.freeze({
    origin: 'https://example.invalid',
    pathname: '/apply',
    domGeneration: sha('a'),
  });

  const runProjection = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    binding,
    discoveryComplete: true,
    rows: [
      { questionId: 'q-one', required: true, state: 'FILLED', reason: null },
      { questionId: 'q-two', required: true, state: 'MANUAL_REQUIRED', reason: 'PASSWORD' },
      { questionId: 'q-three', required: false, state: 'PREFILLED', reason: null },
    ],
    unobservedRegions: [],
    summary: {
      observableQuestions: 3,
      requiredQuestions: 2,
      requiredCompleted: 1,
      terminalQuestions: 3,
      unobservedRegions: 0,
    },
    ...over,
  });

  it('accepts a run projection whose counts it can recompute', () => {
    const parsed = parsePilotUa5RunProjection(runProjection());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.summary.requiredCompleted).toBe(1);
  });

  it('refuses a caller-asserted completion count', () => {
    expect(parsePilotUa5RunProjection(runProjection({
      summary: { observableQuestions: 3, requiredQuestions: 2, requiredCompleted: 2, terminalQuestions: 3, unobservedRegions: 0 },
    })).ok).toBe(false);
  });

  it('refuses a question stated twice, so one question cannot hold two states', () => {
    expect(parsePilotUa5RunProjection(runProjection({
      rows: [
        { questionId: 'q-one', required: true, state: 'FILLED', reason: null },
        { questionId: 'q-one', required: true, state: 'MANUAL_REQUIRED', reason: 'PASSWORD' },
      ],
      summary: { observableQuestions: 2, requiredQuestions: 2, requiredCompleted: 1, terminalQuestions: 2, unobservedRegions: 0 },
    })).ok).toBe(false);
  });

  it('carries an unobserved region through to the panel and refuses a whole-page claim over it', () => {
    const region = 'f'.repeat(64);
    const withRegion = runProjection({
      discoveryComplete: false,
      unobservedRegions: [{ regionId: region, reason: 'FRAME_NOT_OBSERVED' }],
      summary: { observableQuestions: 3, requiredQuestions: 2, requiredCompleted: 1, terminalQuestions: 3, unobservedRegions: 1 },
    });
    const parsed = parsePilotUa5RunProjection(withRegion);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // The rows are the observed questions only; the region is beside them, never among them.
      expect(parsed.value.rows).toHaveLength(3);
      expect(parsed.value.unobservedRegions).toEqual([{ regionId: region, reason: 'FRAME_NOT_OBSERVED' }]);
      expect(parsed.value.summary.unobservedRegions).toBe(1);
      expect(parsed.value.discoveryComplete).toBe(false);
    }
    expect(parsePilotUa5RunProjection({ ...withRegion, discoveryComplete: true }).ok).toBe(false);
    expect(parsePilotUa5RunProjection({
      ...withRegion, summary: { ...withRegion.summary, unobservedRegions: 0 },
    }).ok).toBe(false);
    expect(parsePilotUa5RunProjection({
      ...withRegion, unobservedRegions: [{ regionId: 'q-one', reason: 'FRAME_NOT_OBSERVED' }],
    }).ok).toBe(false);
    expect(parsePilotUa5RunProjection({
      ...withRegion, unobservedRegions: [{ regionId: region, reason: 'CROSS_ORIGIN_IFRAME_UNREACHABLE' }],
    }).ok).toBe(false);
  });

  it('ties discoveryComplete to the rows as the ledger does, and refuses the v1 wire', () => {
    // A DISCOVERY_INCOMPLETE row with a whole-page claim was previously left to
    // the ledger to catch; the projection now refuses it on its own.
    expect(parsePilotUa5RunProjection(runProjection({
      rows: [{ questionId: 'q-one', required: true, state: 'DISCOVERY_INCOMPLETE', reason: 'FUTURE_STEP_NOT_OPENED' }],
      summary: { observableQuestions: 1, requiredQuestions: 1, requiredCompleted: 0, terminalQuestions: 1, unobservedRegions: 0 },
    })).ok).toBe(false);
    expect(parsePilotUa5RunProjection(runProjection({ discoveryComplete: false })).ok).toBe(false);
    expect(parsePilotUa5RunProjection(runProjection({ schemaVersion: 1 })).ok).toBe(false);
    const { unobservedRegions: _regions, ...withoutRegions } = runProjection();
    expect(parsePilotUa5RunProjection(withoutRegions).ok).toBe(false);
  });

  it('refuses a state outside the existing terminal closed set', () => {
    expect(parsePilotUa5RunProjection(runProjection({
      rows: [{ questionId: 'q-one', required: true, state: 'DONE', reason: null }],
      summary: { observableQuestions: 1, requiredQuestions: 1, requiredCompleted: 0, terminalQuestions: 1, unobservedRegions: 0 },
    })).ok).toBe(false);
  });

  it('refuses a composition request that carries an unexpected field', () => {
    expect(parsePilotUa5CompositionRequest({
      schemaVersion: 1,
      trigger: 'USER_CURRENT_PAGE_REQUEST',
      discovery: { schemaVersion: 1, binding, controls: [] },
      answers: [],
      rawValue: 'never',
    }).ok).toBe(false);
  });

  it('refuses an answer reference that is not a pair of digests', () => {
    const base = {
      schemaVersion: 1,
      trigger: 'USER_CURRENT_PAGE_REQUEST',
      discovery: { schemaVersion: 1, binding, controls: [] },
    };
    expect(parsePilotUa5CompositionRequest({
      ...base,
      answers: [{ identityDigest: sha('b'), answerAuthority: 'PROFILE_CONFIRMED', answerDigest: 'plaintext' }],
    }).ok).toBe(false);
    expect(parsePilotUa5CompositionRequest({
      ...base,
      answers: [{ identityDigest: sha('b'), answerAuthority: 'GUESSED', answerDigest: sha('c') }],
    }).ok).toBe(false);
  });
});
