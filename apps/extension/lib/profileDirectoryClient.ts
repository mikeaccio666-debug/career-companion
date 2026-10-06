import {
  APPLICATION_SIGNING_CONSENT_VERSION,
  PROFILE_DIRECTORY_WRITABLE_FIELD_KEYS,
  parseApplicationSigningConsentResponse,
  parseResumeLibrarySnapshotV1,
  type ResumeLibrarySnapshotV1,
  parseCandidateProfileSnapshotV2,
  parseCandidateProfileV2Patch,
  parseEeoSelfIdentificationUpdateV1,
  parseProfileDirectoryPersonalUpdateV1,
  parseProfileDirectoryPreferencesUpdateV1,
  parseProfileDirectoryWorkAuthorizationUpdateV1,
  type ApplicationProfileFieldKey,
  type CandidateProfileSnapshotV2,
  type EeoSelfIdentificationUpdateV1,
  type PatchCandidateProfileV2,
  type EeoSelfIdentificationV1,
  type ProfileDirectoryPersonalUpdateV1,
  type ProfileDirectoryPersonalV1,
  type ProfileDirectoryPreferencesUpdateV1,
  type ProfileDirectoryPreferencesV1,
  type ProfileDirectoryWorkAuthorizationUpdateV1,
  type ProfileDirectoryWorkAuthorizationV1,
} from '@edaix/contracts';
import type {
  DirectoryResponseText,
  ProfileDirectoryOperation,
  ProfileDirectoryTransportCode,
  ProfileDirectoryTransportResult,
} from './profileDirectoryTransport';

/**
 * The saved-details panel's view of the profile — readable and writable at any
 * time, with no fill in progress.
 *
 * `profileClient.ts` is the other profile reader and is not a substitute: it
 * answers only for a signed grant's field keys and stops the fill outright when
 * the profile has moved. That is right for putting values into someone's job
 * application and no use to a user who has opened a panel to check what we hold
 * on them.
 *
 * This half does the checking and runs in the panel's own bundle; the worker
 * half holds the token and makes the request. The checks live here because this
 * is where the values are used, and because the worker's artifact budget has
 * about 4KB to spare while this bundle has 160KB — but the ordering matters
 * more than the arithmetic: nothing reads a field off an answer until that
 * answer has been through the shape check below, and the worker hands back
 * text, which has no fields to read.
 *
 * Four sections, four calls. EEO self-identification goes to its own endpoint
 * and comes back in its own shape — never mixed into the ordinary profile
 * response, which the fill-chain client rejects wholesale as
 * `PROFILE_SENSITIVE_SMUGGLED` for exactly that reason. Nothing here infers an
 * answer: every field is what the user typed or chose.
 */
export type ProfileDirectoryCode =
  | ProfileDirectoryTransportCode
  /** The caller's own input did not satisfy the contract; nothing was sent. */
  | 'INVALID'
  /** Malformed or unknown-shaped answer; discarded whole. */
  | 'RESPONSE_MALFORMED'
  /**
   * 代填授权（2026-09-28）：服务端此刻要的文案版本不是这版插件显示的那一版。编辑器不摆那一格——同意一段它没显示的
   * 文案会被服务端拒，而把那一格显示成「没开」也不对（他可能同意着旧的一版）。
   */
  | 'VERSION_MISMATCH'
  /** A self-identification answer arrived on the ordinary profile channel. */
  | 'SENSITIVE_SMUGGLED'
  /** 上一次读到的那一份里没有这一样（2026-10-04）。 */
  | 'NO_CACHE';

export type ProfileDirectoryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: ProfileDirectoryCode }>;

/**
 * The way to the worker. It names an operation, never a URL, so a panel that
 * has been taken over still cannot aim the worker's bearer token somewhere of
 * its own choosing.
 */
export interface ProfileDirectoryChannel {
  readonly run: (
    operation: ProfileDirectoryOperation,
    body?: unknown,
  ) => Promise<ProfileDirectoryTransportResult>;
  /**
   * 上一次读到的那一份（2026-10-04）：worker 的答复原样交来（`profile-directory/cached`），形状在这里判。没接就没有。
   */
  readonly cached?: () => Promise<unknown>;
}

/** 上一次读到的那一份，四格各自走现读的那道门判过；资料那一格判不过就是 null（整份不摆）。 */
export interface ProfileDirectoryCachedView {
  readonly profileV2: Readonly<{ at: number; value: CandidateProfileSnapshotV2 }> | null;
  readonly eeo: ProfileDirectoryResult<EeoSelfIdentificationV1>;
  readonly signingConsent: ProfileDirectoryResult<boolean>;
  readonly resumeLibrary: ProfileDirectoryResult<ResumeLibrarySnapshotV1>;
}

export interface ProfileDirectoryClient {
  readonly personal: () => Promise<ProfileDirectoryResult<ProfileDirectoryPersonalV1>>;
  readonly savePersonal: (
    update: ProfileDirectoryPersonalUpdateV1,
  ) => Promise<ProfileDirectoryResult<ProfileDirectoryPersonalV1>>;
  readonly workAuthorization: () => Promise<ProfileDirectoryResult<ProfileDirectoryWorkAuthorizationV1>>;
  readonly saveWorkAuthorization: (
    update: ProfileDirectoryWorkAuthorizationUpdateV1,
  ) => Promise<ProfileDirectoryResult<ProfileDirectoryWorkAuthorizationV1>>;
  /** Self-identification, on its own contract. */
  readonly eeo: () => Promise<ProfileDirectoryResult<EeoSelfIdentificationV1>>;
  readonly saveEeo: (
    update: EeoSelfIdentificationUpdateV1,
  ) => Promise<ProfileDirectoryResult<EeoSelfIdentificationV1>>;
  readonly preferences: () => Promise<ProfileDirectoryResult<ProfileDirectoryPreferencesV1>>;
  readonly savePreferences: (
    update: ProfileDirectoryPreferencesUpdateV1,
  ) => Promise<ProfileDirectoryResult<ProfileDirectoryPreferencesV1>>;
  /**
   * The owner's full Profile V2, on its own contract.
   *
   * Read through the contract's own parser: a snapshot that fails it is
   * discarded whole rather than shown with the parts that happened to parse.
   * A save is validated locally first, so nothing malformed spends a token,
   * and the answer is the fresh snapshot the server holds after the write.
   */
  readonly profileV2: () => Promise<ProfileDirectoryResult<CandidateProfileSnapshotV2>>;
  readonly saveProfileV2: (
    patch: PatchCandidateProfileV2,
  ) => Promise<ProfileDirectoryResult<CandidateProfileSnapshotV2>>;
  /**
   * 「代填授权」的同意（2026-09-23；2026-09-24 起文案逐类点名六类同意；2026-09-28 起再加第五刀的新类别）：
   * 同意着这版插件显示的那一版才是 true。服务端要的是别的版本 → VERSION_MISMATCH；解不开的答复是
   * RESPONSE_MALFORMED，不是「没同意」——编辑器据此不摆那一格。
   */
  readonly signingConsent: () => Promise<ProfileDirectoryResult<boolean>>;
  /**
   * 在资料编辑器里打开或关掉那一项；答复是服务端此刻的状态。打开时请求体带这版插件显示的文案版本，
   * 服务端当前版本不是它就拒（UNAVAILABLE）。
   */
  readonly setSigningConsent: (granted: boolean) => Promise<ProfileDirectoryResult<boolean>>;
  /** 简历库（默认简历在哪一条、库的 revision）。 */
  readonly resumeLibrary: () => Promise<ProfileDirectoryResult<ResumeLibrarySnapshotV1>>;
  /** 把一条简历设为默认；带上读到的库 revision，别处刚改过就是 STALE。 */
  readonly setDefaultResume: (
    trackId: string,
    expectedLibraryRevision: string,
  ) => Promise<ProfileDirectoryResult<ResumeLibrarySnapshotV1>>;
  /** 上一次读到的那一份（先摆出来给人看，后台再现读）；问不到、没有、形状不对都是 null。 */
  readonly cached: () => Promise<ProfileDirectoryCachedView | null>;
}

const ORDINARY_FIELD_KEYS: ReadonlySet<string> = new Set<string>([
  ...PROFILE_DIRECTORY_WRITABLE_FIELD_KEYS,
  // Readable, not writable: free text carried over from the pre-V2 profile.
  'location',
]);

/**
 * Sensitive key names, aliases included, kept as depth behind the exact-shape
 * check rather than instead of it. The two disagree only if the wire has
 * changed under us, and that is precisely when a tripwire is worth having.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'gender', 'genderIdentity', 'sex', 'eeoSex', 'race', 'raceEthnicity', 'ethnicity',
  'hispanicLatino', 'veteran', 'veteranStatus', 'disability', 'disabilityStatus',
  'lgbtq', 'sexualOrientation', 'orientation', 'transgender', 'transgenderStatus',
  'pronouns', 'eeo', 'eeoAnswers', 'selfIdentification',
]);

export function createProfileDirectoryClient(
  channel: ProfileDirectoryChannel,
  onDiagnostic?: (code: ProfileDirectoryCode) => void,
): ProfileDirectoryClient {
  /** Stable reason codes only; never a value, a field name or a response body. */
  const fail = (code: ProfileDirectoryCode): ProfileDirectoryResult<never> => {
    onDiagnostic?.(code);
    return { ok: false, code };
  };

  /**
   * The one door from an unchecked answer to a usable one. Every method goes
   * through it, so there is no path on which a section is read without its
   * shape having been verified first.
   */
  const opened = <T>(
    result: ProfileDirectoryTransportResult,
    check: (record: Record<string, unknown>) => ProfileDirectoryCode | null,
  ): ProfileDirectoryResult<T> => {
    if (!result.ok) return fail(result.code);
    const record = decode(result.text);
    if (record === null || record['schemaVersion'] !== 1) return fail('RESPONSE_MALFORMED');
    const rejection = check(record);
    return rejection === null ? { ok: true, value: record as T } : fail(rejection);
  };

  const client: ProfileDirectoryClient = {
    async personal() {
      return opened<ProfileDirectoryPersonalV1>(await channel.run('PERSONAL_READ'), isPersonal);
    },
    async savePersonal(update) {
      if (!parseProfileDirectoryPersonalUpdateV1(update)) return fail('INVALID');
      return opened<ProfileDirectoryPersonalV1>(await channel.run('PERSONAL_SAVE', update), isPersonal);
    },
    async workAuthorization() {
      return opened<ProfileDirectoryWorkAuthorizationV1>(
        await channel.run('WORK_AUTHORIZATION_READ'), isWorkAuthorization,
      );
    },
    async saveWorkAuthorization(update) {
      if (!parseProfileDirectoryWorkAuthorizationUpdateV1(update)) return fail('INVALID');
      return opened<ProfileDirectoryWorkAuthorizationV1>(
        await channel.run('WORK_AUTHORIZATION_SAVE', update), isWorkAuthorization,
      );
    },
    async eeo() {
      return opened<EeoSelfIdentificationV1>(await channel.run('EEO_READ'), isEeo);
    },
    async saveEeo(update) {
      // Reuse is a decision the user makes here, so it is sent every time
      // rather than left to whatever the row happened to hold.
      if (!parseEeoSelfIdentificationUpdateV1(update)) return fail('INVALID');
      return opened<EeoSelfIdentificationV1>(await channel.run('EEO_SAVE', update), isEeo);
    },
    async preferences() {
      return opened<ProfileDirectoryPreferencesV1>(
        await channel.run('PREFERENCES_READ'), isPreferences,
      );
    },
    async savePreferences(update) {
      if (!parseProfileDirectoryPreferencesUpdateV1(update)) return fail('INVALID');
      return opened<ProfileDirectoryPreferencesV1>(
        await channel.run('PREFERENCES_SAVE', update), isPreferences,
      );
    },
    async profileV2() {
      return openedV2(await channel.run('PROFILE_V2_READ'));
    },
    async saveProfileV2(patch) {
      if (parseCandidateProfileV2Patch(patch) === null) return fail('INVALID');
      return openedV2(await channel.run('PROFILE_V2_SAVE', patch));
    },
    async signingConsent() {
      return openedConsent(await channel.run('SIGNING_CONSENT_READ'));
    },
    async setSigningConsent(granted) {
      // 同意时带上这版插件显示的文案版本（2026-09-24）：服务端当前版本不是它就拒，不会把一段用户没看到
      // 的文案记成他的同意。撤回不带：撤回什么版本都安全。
      return openedConsent(await (granted
        ? channel.run('SIGNING_CONSENT_GRANT', { policyVersion: APPLICATION_SIGNING_CONSENT_VERSION })
        : channel.run('SIGNING_CONSENT_REVOKE')));
    },
    async resumeLibrary() {
      return openedLibrary(await channel.run('RESUME_LIBRARY_READ'));
    },
    async setDefaultResume(trackId, expectedLibraryRevision) {
      return openedLibrary(await channel.run('RESUME_DEFAULT_SET', { trackId, expectedLibraryRevision }));
    },
    async cached() {
      let reply: unknown;
      try {
        reply = await channel.cached?.();
      } catch {
        return null;
      }
      const record = plainRecord(reply);
      const slots = record?.['ok'] === true ? plainRecord(record['slots']) : null;
      if (slots === null) return null;
      /** 一格：{at, text}；形状不对当没有。 */
      const slot = (name: string): Readonly<{ at: number; result: ProfileDirectoryTransportResult }> | null => {
        const entry = plainRecord(slots[name]);
        const at = entry?.['at'];
        const text = entry?.['text'];
        return typeof at === 'number' && Number.isFinite(at) && typeof text === 'string'
          ? { at, result: { ok: true, text: text as DirectoryResponseText } }
          : null;
      };
      const none: ProfileDirectoryResult<never> = { ok: false, code: 'NO_CACHE' };
      const profile = slot('PROFILE_V2');
      const v2 = profile === null ? null : openedV2(profile.result);
      const eeo = slot('EEO');
      const consent = slot('SIGNING_CONSENT');
      const library = slot('RESUME_LIBRARY');
      return {
        profileV2: profile !== null && v2 !== null && v2.ok ? { at: profile.at, value: v2.value } : null,
        eeo: eeo === null ? none : opened<EeoSelfIdentificationV1>(eeo.result, isEeo),
        signingConsent: consent === null ? none : openedConsent(consent.result),
        resumeLibrary: library === null ? none : openedLibrary(library.result),
      };
    },
  };

  const openedJson = (result: ProfileDirectoryTransportResult): ProfileDirectoryResult<unknown> => {
    if (!result.ok) return fail(result.code);
    try {
      return { ok: true, value: JSON.parse(result.text) as unknown };
    } catch {
      return fail('RESPONSE_MALFORMED');
    }
  };
  const openedConsent = (result: ProfileDirectoryTransportResult): ProfileDirectoryResult<boolean> => {
    const opened = openedJson(result);
    if (!opened.ok) return opened;
    const consent = parseApplicationSigningConsentResponse(opened.value);
    if (consent === null) return fail('RESPONSE_MALFORMED');
    // 服务端要的文案版本不是这版插件显示的那一版（老服务端还在 09-24，或者这版插件旧了）：不摆那一格。
    if (consent.policyVersion !== APPLICATION_SIGNING_CONSENT_VERSION) return fail('VERSION_MISMATCH');
    return { ok: true, value: consent.granted };
  };
  const openedLibrary = (result: ProfileDirectoryTransportResult): ProfileDirectoryResult<ResumeLibrarySnapshotV1> => {
    const opened = openedJson(result);
    if (!opened.ok) return opened;
    const library = parseResumeLibrarySnapshotV1(opened.value);
    return library === null ? fail('RESPONSE_MALFORMED') : { ok: true, value: library };
  };

  /** The V2 door: the contract's own parser decides, and a malformed snapshot is refused whole. */
  const openedV2 = (
    result: ProfileDirectoryTransportResult,
  ): ProfileDirectoryResult<CandidateProfileSnapshotV2> => {
    if (!result.ok) return fail(result.code);
    let raw: unknown;
    try {
      raw = JSON.parse(result.text) as unknown;
    } catch {
      return fail('RESPONSE_MALFORMED');
    }
    const snapshot = parseCandidateProfileSnapshotV2(raw);
    return snapshot === null ? fail('RESPONSE_MALFORMED') : { ok: true, value: snapshot };
  };
  return Object.freeze(client);
}

/** Text in, record out. The only place an unchecked answer is ever opened. */
function decode(text: DirectoryResponseText): Record<string, unknown> | null {
  try {
    return plainRecord(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function isPersonal(record: Record<string, unknown>): ProfileDirectoryCode | null {
  if (!revision(record['revision']) || !revision(record['deletionEpoch'])) return 'RESPONSE_MALFORMED';
  const fields = plainRecord(record['fields']);
  if (fields === null) return 'RESPONSE_MALFORMED';
  for (const key of Object.keys(fields)) {
    // Checked before the exact-shape test so a self-identification answer is
    // reported as what it is, not as a merely unknown key.
    if (SENSITIVE_KEYS.has(key)) return 'SENSITIVE_SMUGGLED';
    if (!ORDINARY_FIELD_KEYS.has(key)) return 'RESPONSE_MALFORMED';
  }
  for (const key of ORDINARY_FIELD_KEYS) {
    const value = fields[key as ApplicationProfileFieldKey];
    if (!(key in fields) || (value !== null && typeof value !== 'string')) return 'RESPONSE_MALFORMED';
  }
  return null;
}

function isWorkAuthorization(record: Record<string, unknown>): ProfileDirectoryCode | null {
  if (!revision(record['profileRevision']) || !revision(record['deletionEpoch'])
    || !revision(record['preferencesRevision'])
    || typeof record['reuseEnabled'] !== 'boolean'
    || !Array.isArray(record['entries'])) return 'RESPONSE_MALFORMED';
  const ok = record['entries'].every((entry) => {
    const item = plainRecord(entry);
    return item !== null
      && Object.keys(item).length === 3
      && typeof item['regionCode'] === 'string' && /^[A-Z]{2}$/u.test(item['regionCode'])
      && isAnswer(item['authorizedToWork']) && isAnswer(item['requiresSponsorship']);
  });
  return ok ? null : 'RESPONSE_MALFORMED';
}

function isEeo(record: Record<string, unknown>): ProfileDirectoryCode | null {
  if (typeof record['reuseEnabled'] !== 'boolean' || !revision(record['revision'])) {
    return 'RESPONSE_MALFORMED';
  }
  const answers = plainRecord(record['answers']);
  if (answers === null) return 'RESPONSE_MALFORMED';
  // The wordings the user chose, kept verbatim so a host option is only ever
  // matched exactly. Anything else is not an answer this panel can show back.
  const ok = Object.values(answers).every((values) =>
    Array.isArray(values) && values.length > 0 && values.every((text) => typeof text === 'string'));
  return ok ? null : 'RESPONSE_MALFORMED';
}

function isPreferences(record: Record<string, unknown>): ProfileDirectoryCode | null {
  return revision(record['revision'])
    && typeof record['workAuthorizationReuseEnabled'] === 'boolean'
    && (record['primaryTimeZone'] === null || typeof record['primaryTimeZone'] === 'string')
    ? null : 'RESPONSE_MALFORMED';
}

const isAnswer = (value: unknown): boolean =>
  value === 'YES' || value === 'NO' || value === 'UNSPECIFIED';

const revision = (value: unknown): boolean =>
  typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(value);

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
