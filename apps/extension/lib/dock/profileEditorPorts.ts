import type { CandidateProfileSnapshotV2 } from '@edaix/contracts';

/**
 * 资料编辑器除 Profile V2 之外要读写的几样（2026-09-23）：自我认同、代填授权、默认简历。
 *
 * 浮层自己不发请求——凭据只在 worker 里。这几个口子由内容脚本经 worker 接上；没接的那一块，
 * 编辑器照实显示「暂时读不到」，不摆一张空表。
 */

/** 自我认同：存的是门户那几句英文原文（`self-identification-options.ts`），不是显示文字。 */
export interface DockEeoAnswers {
  readonly genderIdentity: string;
  readonly hispanicLatino: string;
  readonly raceEthnicity: readonly string[];
  readonly veteranStatus: string;
  readonly disabilityStatus: string;
  /** 「允许插件把这些答案填进申请表」——门户上单独的一个同意。 */
  readonly reuseEnabled: boolean;
}

export interface DockEeoRecord {
  readonly answers: DockEeoAnswers;
  readonly revision: string;
}

export interface DockResumeOption {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
}

export interface DockResumeLibrary {
  readonly items: readonly DockResumeOption[];
  readonly defaultId: string | null;
}

export type DockPortResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: string }>;

/**
 * 上一次读到的那一份（2026-10-04，先显示旧的、后台换新）：插件 worker 记在 `chrome.storage.session` 里——只在这次浏览器
 * 会话、只给这个账号（换了账号、退出登录就清掉），不落盘。四样各自可缺（还没读过的那一样就是 `ok: false`）。
 */
export interface DockProfileCached {
  /** 资料那一份是什么时候从服务器读到的（毫秒）。 */
  readonly at: number;
  readonly profile: CandidateProfileSnapshotV2;
  readonly eeo: DockPortResult<DockEeoRecord>;
  readonly consent: DockPortResult<boolean>;
  readonly resumes: DockPortResult<DockResumeLibrary>;
}

export interface DockProfileEditorPorts {
  /** 上一次读到的那一份；没有（或认不出）就是 null，编辑器照旧先转圈。 */
  readonly cached?: () => Promise<DockProfileCached | null>;
  readonly eeo?: {
    readonly load: () => Promise<DockPortResult<DockEeoRecord>>;
    readonly save: (answers: DockEeoAnswers, expectedRevision: string) => Promise<DockPortResult<DockEeoRecord>>;
  };
  readonly signing?: {
    readonly load: () => Promise<DockPortResult<boolean>>;
    readonly set: (granted: boolean) => Promise<DockPortResult<boolean>>;
  };
  readonly resumes?: {
    readonly load: () => Promise<DockPortResult<DockResumeLibrary>>;
    readonly setDefault: (id: string) => Promise<DockPortResult<string>>;
  };
}
