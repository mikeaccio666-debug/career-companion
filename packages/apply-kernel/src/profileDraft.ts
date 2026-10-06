/**
 * Legacy local profile migration boundary.
 *
 * `vibeApplyProfile` predates the account-owned profile authorization. New
 * code must never write it or use it to build a Fill plan: it is read only
 * long enough to offer the candidate one explicit choice (upload or delete),
 * then hard-deleted. The one extra local key below is a value-free deadline
 * marker, not a profile cache.
 */

import { APPLY_FIELD_KEYS, type ApplyFieldKey, type Result } from './contracts';
import { isValidApplicationProfileFieldValue } from './applicationProfileFieldValidation';
import {
  APPLY_PROFILE_KEY,
  APPLY_PROFILE_MIGRATION_NOTICE_KEY,
  APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
} from './legacyProfileKeys';

export {
  APPLY_PROFILE_KEY,
  APPLY_PROFILE_MIGRATION_NOTICE_KEY,
  APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
} from './legacyProfileKeys';

export const APPLY_PROFILE_SCHEMA_VERSION = 2;
export const LEGACY_PROFILE_MIGRATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/** 资料草稿：键与引擎的字段键一一对应，便于零映射查表。 */
export type ApplyProfileDraft = Partial<Record<ApplyFieldKey, string>>;

/** The old envelope, retained solely so an upgraded extension can read it once. */
interface StoredApplyProfile {
  readonly v: typeof APPLY_PROFILE_SCHEMA_VERSION;
  readonly updatedAt: number;
  readonly data: ApplyProfileDraft;
}

export type ApplyProfileStorageError = 'STORAGE_UNAVAILABLE';

export type LegacyApplyProfileState =
  | { readonly kind: 'absent' }
  | {
      /** A safe, bounded value set the candidate may explicitly upload once. */
      readonly kind: 'migratable';
      readonly draft: ApplyProfileDraft;
      readonly startedAt: number;
    }
  | {
      /** Delete remains available, but an unknown shape must never be uploaded. */
      readonly kind: 'unreadable';
      readonly startedAt: number;
    }
  | {
      /** The privacy deadline already deleted the old value; no value crosses this boundary. */
      readonly kind: 'expired';
    };

export type LegacyApplyProfileRead = Result<LegacyApplyProfileState, ApplyProfileStorageError>;
export type LegacyApplyProfileDelete = Result<void, ApplyProfileStorageError>;

/**
 * The background worker receives this value-free view only. It must never
 * receive a `draft`: scheduling a privacy deadline does not need one.
 */
export type LegacyProfileMigrationDeadlineState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'pending'; readonly startedAt: number }
  | { readonly kind: 'expired' };
export type LegacyProfileMigrationDeadlineRead = Result<
  LegacyProfileMigrationDeadlineState,
  ApplyProfileStorageError
>;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * A legacy record is uploadable only when every stored *known* field already
 * satisfies the current account contract. This prevents an old phone/URL from
 * passing the local boundary only to be rejected by IPC or HTTP after the
 * candidate chose Upload. Unknown fields remain out of the L1 draft entirely.
 */
function parseLegacyDraft(value: Record<string, unknown>): ApplyProfileDraft | null {
  const draft: ApplyProfileDraft = {};
  let sawKnownField = false;
  for (const key of APPLY_FIELD_KEYS) {
    if (!hasOwn(value, key)) continue;
    sawKnownField = true;
    const raw = value[key];
    if (!isValidApplicationProfileFieldValue(key, raw)) return null;
    draft[key] = raw.trim();
  }
  return sawKnownField ? draft : null;
}

type ParsedLegacyProfile =
  | { readonly kind: 'migratable'; readonly draft: ApplyProfileDraft }
  | { readonly kind: 'unreadable' };

/**
 * Old flat values and the v2 envelope are uploadable only after an explicit
 * candidate click. A malformed/newer envelope is deliberately *not* an error
 * that traps its PII forever: it is unreadable but still removable.
 */
function parseLegacyProfile(raw: unknown): ParsedLegacyProfile {
  if (!isRecord(raw)) return { kind: 'unreadable' };
  if (!hasOwn(raw, 'v')) {
    const draft = parseLegacyDraft(raw);
    return draft
      ? { kind: 'migratable', draft }
      : { kind: 'unreadable' };
  }

  if (
    raw.v !== APPLY_PROFILE_SCHEMA_VERSION ||
    !isFiniteTimestamp(raw.updatedAt) ||
    !isRecord(raw.data)
  ) {
    return { kind: 'unreadable' };
  }
  const envelope = raw as unknown as StoredApplyProfile;
  const draft = parseLegacyDraft(envelope.data as Record<string, unknown>);
  return draft
    ? { kind: 'migratable', draft }
    : { kind: 'unreadable' };
}

async function readLegacyStorage(): Promise<Result<Record<string, unknown>, ApplyProfileStorageError>> {
  try {
    const stored = (await browser.storage.local.get([
      APPLY_PROFILE_KEY,
      APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
      APPLY_PROFILE_MIGRATION_NOTICE_KEY,
    ])) as Record<string, unknown>;
    return { ok: true, value: stored };
  } catch {
    return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  }
}

/**
 * The service worker needs to know whether the retired key exists, but must
 * never deserialize its value. `getBytesInUse(key)` is the Chrome storage
 * presence probe: it returns only a byte count, while the accompanying read
 * is limited to the value-free deadline metadata.
 */
interface LegacyProfileMigrationMetadata {
  readonly hasLegacyProfile: boolean;
  readonly marker: unknown;
  readonly notice: unknown;
}

function migrationMetadataFromStored(
  stored: Record<string, unknown>,
): LegacyProfileMigrationMetadata {
  return {
    hasLegacyProfile: hasOwn(stored, APPLY_PROFILE_KEY),
    marker: stored[APPLY_PROFILE_MIGRATION_STARTED_AT_KEY],
    notice: stored[APPLY_PROFILE_MIGRATION_NOTICE_KEY],
  };
}

async function readValueFreeLegacyMigrationMetadata(): Promise<
  Result<LegacyProfileMigrationMetadata, ApplyProfileStorageError>
> {
  try {
    const [metadata, bytesInUse] = await Promise.all([
      browser.storage.local.get([
        APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
        APPLY_PROFILE_MIGRATION_NOTICE_KEY,
      ]),
      browser.storage.local.getBytesInUse(APPLY_PROFILE_KEY),
    ]);
    if (!Number.isSafeInteger(bytesInUse) || bytesInUse < 0) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    }
    const stored = metadata as Record<string, unknown>;
    return {
      ok: true,
      value: {
        hasLegacyProfile: bytesInUse > 0,
        marker: stored[APPLY_PROFILE_MIGRATION_STARTED_AT_KEY],
        notice: stored[APPLY_PROFILE_MIGRATION_NOTICE_KEY],
      },
    };
  } catch {
    return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  }
}

async function expireLegacyApplyProfile(): Promise<LegacyApplyProfileDelete> {
  try {
    await browser.storage.local.remove([
      APPLY_PROFILE_KEY,
      APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
    ]);
    // A one-shot value-free notice lets a later panel honestly explain a
    // background cleanup. It is consumed by the content session on display.
    await browser.storage.local.set({ [APPLY_PROFILE_MIGRATION_NOTICE_KEY]: 'expired' });
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  }
}

async function resolveLegacyProfileMigrationDeadline(
  metadata: LegacyProfileMigrationMetadata,
  now: number,
  options: { readonly consumeExpiredNotice?: boolean },
): Promise<LegacyProfileMigrationDeadlineRead> {
  if (!metadata.hasLegacyProfile) {
    if (metadata.notice === 'expired') {
      if (options.consumeExpiredNotice === false) return { ok: true, value: { kind: 'expired' } };
      try {
        await browser.storage.local.remove(APPLY_PROFILE_MIGRATION_NOTICE_KEY);
      } catch {
        return { ok: false, code: 'STORAGE_UNAVAILABLE' };
      }
      return { ok: true, value: { kind: 'expired' } };
    }
    return { ok: true, value: { kind: 'absent' } };
  }

  const marker = metadata.marker;
  const startedAt = isFiniteTimestamp(marker) && marker <= now ? marker : now;
  if (startedAt === now && marker !== now) {
    try {
      // This is intentionally the only `set` in this module. It writes no L1
      // value, only the deadline needed to guarantee eventual hard deletion.
      await browser.storage.local.set({ [APPLY_PROFILE_MIGRATION_STARTED_AT_KEY]: startedAt });
    } catch {
      return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    }
  }

  if (now - startedAt >= LEGACY_PROFILE_MIGRATION_WINDOW_MS) {
    const deleted = await expireLegacyApplyProfile();
    return deleted.ok ? { ok: true, value: { kind: 'expired' } } : deleted;
  }

  return { ok: true, value: { kind: 'pending', startedAt } };
}

/**
 * Value-free scheduler boundary. The profile-draft parser is deliberately not
 * involved here: expiry applies to any leftover legacy key, while only a tab
 * opened by the candidate may inspect a recognized value for explicit upload.
 */
export async function readLegacyProfileMigrationDeadline(
  now = Date.now(),
  options: { readonly consumeExpiredNotice?: boolean } = {},
): Promise<LegacyProfileMigrationDeadlineRead> {
  if (!isFiniteTimestamp(now)) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const metadata = await readValueFreeLegacyMigrationMetadata();
  if (!metadata.ok) return metadata;
  return resolveLegacyProfileMigrationDeadline(metadata.value, now, options);
}

/**
 * Read local L1 values only to determine whether migration needs a user
 * decision. An absent key does not create a deadline marker. A present key
 * starts a *value-free* 30-day clock; at the deadline the profile is deleted
 * before this function returns, so callers cannot accidentally use it.
 */
export async function readLegacyApplyProfile(
  now = Date.now(),
  options: { readonly consumeExpiredNotice?: boolean } = {},
): Promise<LegacyApplyProfileRead> {
  if (!isFiniteTimestamp(now)) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const stored = await readLegacyStorage();
  if (!stored.ok) return stored;
  const deadline = await resolveLegacyProfileMigrationDeadline(
    migrationMetadataFromStored(stored.value),
    now,
    options,
  );
  if (!deadline.ok) return deadline;
  if (deadline.value.kind === 'absent') return { ok: true, value: { kind: 'absent' } };
  if (deadline.value.kind === 'expired') return { ok: true, value: { kind: 'expired' } };

  const parsed = parseLegacyProfile(stored.value[APPLY_PROFILE_KEY]);
  return parsed.kind === 'migratable'
    ? { ok: true, value: { kind: 'migratable', draft: parsed.draft, startedAt: deadline.value.startedAt } }
    : { ok: true, value: { kind: 'unreadable', startedAt: deadline.value.startedAt } };
}

/**
 * Explicitly remove the legacy key without parsing it. This must work while
 * logged out and even for a newer/malformed shape, otherwise the privacy
 * migration would itself become a reason to retain unreadable PII forever.
 */
export async function discardLegacyApplyProfile(): Promise<LegacyApplyProfileDelete> {
  try {
    await browser.storage.local.remove([
      APPLY_PROFILE_KEY,
      APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
      APPLY_PROFILE_MIGRATION_NOTICE_KEY,
    ]);
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  }
}

/**
 * 补齐可推导的字段：表单要"全名"而我们只存了姓和名（Lever 要全名，
 * Greenhouse 要拆开），或反之。只做无损推导，不猜测。
 */
/**
 * 被用户长期抑制的字段键。服务端 `suggestions.suppressedKeys` 的镜像。
 *
 * **只有键名，没有值** —— 这是它能穿过 apply 层的原因：apply 层的规矩是
 * "引擎只读权威值、绝不读建议值"，一个纯键名枚举不违反它。
 */
export type SuppressedFieldKeys = ReadonlySet<ApplyFieldKey>;

const NOTHING_SUPPRESSED: SuppressedFieldKeys = new Set<ApplyFieldKey>();

/**
 * 从已有字段补全缺失字段。
 *
 * ⚠️ **`suppressed` 参数不是可选的装饰，它是删除承诺的最后一环。**
 *
 * 用户点了"删除我的自动填充资料"之后，服务端会硬删值并登记一条长期指令，
 * 简历接口也会把被抑制的键从建议里剔除。但**推导会绕过这两道**：
 * `city` 从 `location` 补、`fullName` 与 `firstName/lastName` 互推——
 * 只要还有一个相关字段有值，被删掉的那个就会在计划构造时被重新算出来，
 * 然后填进雇主的申请表。落点比"值回到档案里"更不可逆。
 *
 * 所以推导必须知道哪些键被抑制了，并且**对它们一律不补**。
 * 由 `tests/apply-derive-suppressed.test.ts` 锁死，含反向探针。
 */
export function deriveProfile(
  draft: ApplyProfileDraft,
  suppressed: SuppressedFieldKeys = NOTHING_SUPPRESSED,
): ApplyProfileDraft {
  const derived: ApplyProfileDraft = { ...draft };
  /**
   * 抑制键不作为**推导来源**——否则用户删掉的那个值只是换个键名继续出现在
   * 申请表上（删了 location，它却推出了 city）。
   */
  const usable = (key: ApplyFieldKey): string | undefined =>
    suppressed.has(key) ? undefined : derived[key];

  const firstName = usable('firstName');
  const lastName = usable('lastName');
  if (!usable('fullName') && (firstName || lastName)) {
    derived.fullName = [firstName, lastName].filter(Boolean).join(' ');
  }
  const fullName = usable('fullName');
  if (fullName && (!usable('firstName') || !usable('lastName'))) {
    const parts = fullName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      // 姓名顺序按西方表单习惯（首词为 first、末词为 last）；中文用户可在
      // Autofill 标签页手动覆盖，所以这里只在缺失时补。
      derived.firstName ||= parts[0];
      derived.lastName ||= parts[parts.length - 1];
    }
  }
  if (!usable('location') && usable('city')) derived.location = usable('city');
  if (!usable('city') && usable('location')) derived.city = usable('location');

  // **唯一承重的那道**：抑制键一律不进结果，无论它是原本就有值、还是刚被推导补上。
  //
  // 第一版在每个写入点也各放了一道检查，变异测试证明那是**行为等价的冗余**
  // ——删掉它们结果不变。两道检查看起来更安全，实际是让人分不清哪道承重；
  // 留一道，并且让它被测试直接盯住。
  for (const key of suppressed) delete derived[key];

  return derived;
}
