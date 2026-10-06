/** Frontend application-profile API mirror pending T22 three-person review. */

export const APPLICATION_PROFILE_FIELD_KEYS = [
  "firstName",
  "lastName",
  "fullName",
  "preferredName",
  "email",
  "phone",
  "linkedinUrl",
  "githubUrl",
  "portfolioUrl",
  "city",
  "location",
  "addressLine1",
  "addressRegion",
  "currentCompany",
  "addressCountry",
  "addressPostalCode",
  "currentJobTitle",
  "eeoGender",
  "eeoRace",
  "eeoVeteran",
  "eeoDisability",
  "heardAboutSource",
] as const;

export type ApplicationProfileFieldKey =
  (typeof APPLICATION_PROFILE_FIELD_KEYS)[number];

export type ApplicationProfileFields = Readonly<
  Record<ApplicationProfileFieldKey, string | null>
>;

export type ApplicationProfileSuggestion = {
  readonly key: ApplicationProfileFieldKey;
  readonly value: string;
  readonly source: string;
};

export type ApplicationProfileSnapshot = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly hasStoredProfile: boolean;
  readonly fields: ApplicationProfileFields;
  readonly suggestions: {
    readonly resumeDerivationEnabled: boolean;
    readonly suppressedKeys: readonly ApplicationProfileFieldKey[];
    readonly items: readonly ApplicationProfileSuggestion[];
  };
};

export type ApplicationProfilePatch = {
  readonly expectedRevision: number;
  readonly fields: Partial<
    Record<ApplicationProfileFieldKey, string | null>
  >;
};

export type ApplicationProfilePatchResult = ApplicationProfileSnapshot & {
  readonly applied: readonly ApplicationProfileFieldKey[];
  readonly cleared: readonly ApplicationProfileFieldKey[];
};
