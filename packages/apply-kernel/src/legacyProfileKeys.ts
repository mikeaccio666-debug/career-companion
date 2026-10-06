/**
 * Value-free names for the retired local autofill profile. Keeping these in a
 * tiny standalone module lets a non-autofill build erase stale local data
 * without importing the legacy parser or deserializing any profile value.
 */

export const APPLY_PROFILE_KEY = 'vibeApplyProfile';
export const APPLY_PROFILE_MIGRATION_STARTED_AT_KEY = 'vibeApplyProfileMigrationStartedAt';
export const APPLY_PROFILE_MIGRATION_NOTICE_KEY = 'vibeApplyProfileMigrationNotice';

export const LEGACY_APPLY_PROFILE_STORAGE_KEYS = [
  APPLY_PROFILE_KEY,
  APPLY_PROFILE_MIGRATION_STARTED_AT_KEY,
  APPLY_PROFILE_MIGRATION_NOTICE_KEY,
] as const;
