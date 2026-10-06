import { afterEach, describe, expect, it } from 'vitest';

import { collectAttestationCandidates } from '../src/attest';
import { classifyManualOnly } from '../src/dict/guards';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';

/**
 * 乙档候选挑选的红绿证。
 *
 * 这里锁的**不是**「属实声明能被选中」——那条容易过。锁的是
 * **甲档一条都不许混进来**：密码、验证码、背景调查同意、仲裁协议、
 * 信用报告、药检、营销订阅，以及把两者写在同一个 checkbox 里的复合标签。
 *
 * 代价不对称是本文件全部设计的理由：误否一个真声明 = 用户多点一下；
 * 误纳一个甲档 = **替用户签了一份他没读过的授权，不可逆**。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** 造一张只含复选框的 Greenhouse 表，走真实适配器扫描（不手搓描述符）。 */
function candidatesFor(labels: readonly string[]) {
  document.body.innerHTML = `<form id="application-form">${labels
    .map(
      (text, i) =>
        `<label for="cb${i}">${text}</label><input id="cb${i}" name="cb${i}" type="checkbox" />`,
    )
    .join('')}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单——后面全是空转').not.toBeNull();
  return collectAttestationCandidates([...greenhouseAdapter.scan(root!)], root!);
}

const TRUTHFULNESS = [
  'I certify that the information provided in this application is accurate and complete.',
  'I confirm that the details above are correct to the best of my knowledge.',
  'I attest that the answers I entered in this application are truthful and complete.',
  'I declare that my application responses are correct to the best of my knowledge.',
  '本人声明以上所填写的信息真实、准确、完整无误。',
] as const;

/**
 * 法律 acknowledgement 不是「我填的信息属实」。
 *
 * 它们可能证明用户已阅读、已收到或已完成某个动作，会产生独立法律效果；
 * 不能因为句子里有 confirm/certify 就当成可代勾的 Profile 事实确认。
 */
const LEGAL_ACKNOWLEDGEMENTS = [
  'I confirm that I have read and understand the employee handbook.',
  'I certify that I have received a copy of the employee handbook.',
  'I acknowledge that I reviewed the workplace safety policy.',
  'I acknowledge receipt of the applicant privacy notice.',
  'I confirm that I completed the required code of conduct review.',
  'I certify that I received and reviewed the company policy document.',
  'I confirm my attendance at the required orientation.',
  'I certify that the application information is accurate and that I received the employee handbook.',
  'I confirm that the answers I entered are correct and that I have read the applicant privacy notice.',
  'I have read the employee handbook; I certify that the application information is accurate.',
  'I certify that the application responses are complete; I acknowledge receipt of the privacy notice.',
  'I certify that the application information is accurate and that I attended the required orientation.',
  'I certify that the information is accurate.',
  'I attest that the statements are true.',
  'I declare that the facts contained are correct.',
  '本人声明上述员工手册已阅读，所填信息属实。',
  '本人确认以上政策文件已收到，所提供资料准确。',
  '本人保证上述入职培训已完成，所提交内容完整。',
] as const;

/** 甲档闭集。任意一条被选中都是重大缺陷。 */
const NEVER = [
  'I authorize a background check to be conducted by the employer.',
  'I agree to submit any dispute to binding arbitration rather than court.',
  'I consent to the employer obtaining a credit report about me.',
  'I consent to undergo a pre-employment drug screen if an offer is made.',
  'Subscribe me to marketing emails about future opportunities at this company.',
  'I waive my right to a jury trial for any employment-related claim.',
  'Enter your account password to continue with this application.',
  'Please enter the one-time verification code we sent to your email.',
  // 复合：属实 + 实质授权写在同一个框里。真实申请表上很常见。
  'I certify the information is accurate and I consent to a background check.',
  'I certify the above and agree to the Terms and Conditions and Privacy Policy.',
  ...LEGAL_ACKNOWLEDGEMENTS,
] as const;

describe('甲档一条都不许混进候选', () => {
  it.each(NEVER)('%s → 不选', (label) => {
    const picked = candidatesFor([label]);
    expect(
      picked.map((c) => c.declarationText),
      `「${label}」进了代勾候选——这会替用户签一份他没读过的授权`,
    ).toHaveLength(0);
  });

  it('甲乙同表并存：只挑出乙档那几条', () => {
    // 单条用例里"一条都没选中"证明力弱——它可能因为别的原因空。
    // 这里混着扫，逐条确认挑对了人。
    const picked = candidatesFor([...TRUTHFULNESS, ...NEVER]);
    expect(picked).toHaveLength(TRUTHFULNESS.length);
    for (const text of TRUTHFULNESS) {
      expect(picked.map((c) => c.declarationText)).toContain(text);
    }
    for (const text of NEVER) {
      expect(picked.map((c) => c.declarationText)).not.toContain(text);
    }
  });
});

describe('两道冗余筛各自单独咬住的形态（否则「冗余」是句空话）', () => {
  /**
   * 初版这两道摘掉任何一道，20 条用例照样全绿——它们互相盖住了，
   * 「每一道都独立能否掉一个候选」是没被测过的声称（`docs/64` §1）。
   * 下面两条各自只被其中一道拦下。
   */

  it('第 4 道单独咬住：EEO 自我认同——分档判它 OPT_IN_ELIGIBLE，但它不是属实声明', () => {
    // classifyManualOnly 对 EEO 返回 OPT_IN_ELIGIBLE（它确实是乙档），
    // 所以第 3 道放行。拦下它的是第 4 道的信息属实正向闭集。
    //
    // 这同时锁一条产品边界：**本版不碰 EEO**。EEO 要预填得先有存储、
    // 有法定值域（种族 EEO-1 七类必须多选、残障 CC-305 措辞是法定的），
    // 那是 T3 第二批的活。这里误纳一条 = 勾了一个我们根本没有值的字段。
    const label = 'Please select your gender identity for equal employment opportunity reporting purposes.';
    expect(candidatesFor([label]), `EEO 字段进了代勾候选——本版不该碰它`).toHaveLength(0);
  });

  it('第 3 道单独咬住：带 certify 字样的验证码题', () => {
    // 作证行为 + application information + accurate 三个正向条件全命中，
    // CONSENT_GRANT 不命中——第 4 道放行。
    // 拦下它的是第 3 道：classifyManualOnly 判 NEVER（OTP_OR_CAPTCHA）。
    const label =
      'Enter the verification code we emailed you to certify that the application information provided is accurate.';
    expect(candidatesFor([label]), `验证码题进了代勾候选——那是甲档`).toHaveLength(0);
  });
});

describe('乙档能被选中（否则上面那组是空转）', () => {
  /**
   * 没有这一组，把 `collectAttestationCandidates` 改成 `return []`，
   * 上面所有用例都会绿。
   */
  it.each(TRUTHFULNESS)('%s → 选中', (label) => {
    const picked = candidatesFor([label]);
    expect(picked, `「${label}」没被选中——代勾功能对它无效`).toHaveLength(1);
    expect(picked[0]!.declarationText).toBe(label);
  });
});

describe('法律 acknowledgement 不属于「用户已填信息属实」', () => {
  it.each(LEGAL_ACKNOWLEDGEMENTS)('%s → fail closed', (label) => {
    expect(
      classifyManualOnly(label),
      `「${label}」被分到可代勾档——它证明的是已阅读／已收到，不是已填信息属实`,
    ).toBe('NEVER');
    expect(
      candidatesFor([label]),
      `「${label}」进了信息属实候选——会替用户做一个独立法律 acknowledgement`,
    ).toHaveLength(0);
  });
});

describe('长度闸与蜜罐', () => {
  it('太短的不选（单独一个 I agree 含义不明）', () => {
    expect(candidatesFor(['I agree'])).toHaveLength(0);
  });

  it('太长的不选（多半是把整张卡片抓串了）', () => {
    const huge = `I certify that ${'the information provided is accurate. '.repeat(30)}`;
    expect(huge.length).toBeGreaterThan(600);
    expect(candidatesFor([huge])).toHaveLength(0);
  });

  it('蜜罐即便文案像声明也不选', () => {
    // 误勾蜜罐 = 直接告诉宿主我们是机器人。
    document.body.innerHTML = `<form id="application-form">
      <label for="beecatcher">I certify that the information provided is accurate.</label>
      <input id="beecatcher" name="beecatcher" type="checkbox" />
    </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    expect(collectAttestationCandidates([...greenhouseAdapter.scan(root)], root)).toHaveLength(0);
  });
});

describe('候选 authority 不暴露 wire/receipt 形态', () => {
  it('公开候选只有 UI 原文与结构签名，没有本地 digest/fingerprint 或 element', () => {
    const [candidate] = candidatesFor([TRUTHFULNESS[0]]);
    expect(Object.keys(candidate!).sort()).toEqual(['declarationText', 'signature']);
    expect(candidate).not.toHaveProperty('declarationDigest');
    expect(candidate).not.toHaveProperty('localTextFingerprint');
    expect(candidate).not.toHaveProperty('element');
    expect(Object.isFrozen(candidate)).toBe(true);
  });

  it('结构上伪造的 ScanRoot 不能铸造 candidate', () => {
    document.body.innerHTML = `<form id="application-form">
      <label for="truth">${TRUTHFULNESS[0]}</label>
      <input id="truth" name="truth" type="checkbox" />
    </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = [...greenhouseAdapter.scan(root)];
    const forgedRoot = { ...root };

    expect(collectAttestationCandidates(fields, forgedRoot)).toEqual([]);
    expect(collectAttestationCandidates(fields, root)).toHaveLength(1);
  });
});

/**
 * 省略主语的授权——**这是本文件最要紧的一组**。
 *
 * 代码审查实测（2026-08-19）：`CONSENT_GRANT` 原来用
 * `\bi (consent|authorize|waive)\b`，**要求人称代词紧邻动词**。
 * 而英语并列句会省略后半句主语，这恰好是美国求职申请书认证段的**标准样板**——
 * 下面九条当时 **9/9 全部被选进代勾候选**。
 *
 * 只差一个 "I"：
 *   `…and **I** authorize investigation…` → 拦住
 *   `…and authorize investigation…`       → 放行
 *
 * 而且具名对象是闭集，永远追不完：`Terms of Service`（原只认
 * `terms and conditions`）、`consumer report`（FCRA 法定术语，原只认
 * `credit report`）、`pre-employment screening`（原要求 `background` 前缀）。
 *
 * 修法不是继续加词（黑名单追不上开放集合），而是**正向收窄**：
 * 乙档分支上出现任何授权动词、不论主语，一律落甲档（`AUTHORIZATION_VERB`）。
 */
describe('省略主语的授权：黑名单追不上，靠正向收窄挡', () => {
  it.each([
    ['标准认证段样板', 'I certify that the facts contained in this application are true and complete to the best of my knowledge and authorize investigation of all statements contained herein.'],
    ['FCRA consumer report', 'I certify that the information provided is accurate and authorize Acme to obtain a consumer report about me.'],
    ['pre-employment screening', 'I certify the above is accurate and authorize a pre-employment screening.'],
    ['省主语的 consent', 'I certify the above is true and consent to the processing of my personal data.'],
    ['省主语的 waive', 'I certify the above is true and waive my right to a jury trial.'],
    ['Terms of Service', 'I certify the information is accurate and agree to the Terms of Service.'],
    ['Terms of Use', 'I certify the above and accept the Terms of Use.'],
    ['键入姓名即签名', 'I certify this is correct; my typed name below constitutes my signature.'],
    ['中文·员工手册', '本人声明以上信息属实，并同意接受员工手册及规章制度。'],
  ])('%s → 不选', (_name, label) => {
    expect(
      candidatesFor([label]).map((c) => c.declarationText),
      `「${label.slice(0, 50)}…」进了代勾候选——省略主语的授权被当成纯属实声明了`,
    ).toHaveLength(0);
  });

  /**
   * 反向：收窄不许误伤。
   *
   * 第一版把 `AUTHORIZATION_VERB` 挂成全局规则，
   * `Are you legally authorized to work in the United States?` 也被判 NEVER——
   * 那句是**在问用户状态**，不是授出授权，该走既有的 `JOB_DEPENDENT`。
   * 现在收窄只否决乙档分支。
   */
  it('纯属实声明仍被选中（收窄不许把功能整个拒掉）', () => {
    expect(candidatesFor([...TRUTHFULNESS])).toHaveLength(TRUTHFULNESS.length);
  });
});
