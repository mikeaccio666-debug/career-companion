/** wxt.config.ts 的 vite define 注入（商店包为 null，闸门见 config 头注）。 */
declare const __VIBE_API_BASE__: string | null;
declare const __VIBE_WEB_BASE__: string | null;
/** Explicit S2-B read-only development composition; false in normal/store builds. */
declare const __VIBE_ASSISTANT_READ_ENABLED__: boolean;
/** Explicit S3-A development editor; false in readonly/default/store builds. */
declare const __VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__: boolean;
/** 商店包在 T15 production evidence/final-head gate 前恒为 false。 */
declare const __VIBE_TRUST_TELEMETRY_ENABLED__: boolean;
/** True only for the fixed local Mock rehearsal; normal/store builds are false. */
declare const __VIBE_CONTROLLED_MOCK_WRITES__: boolean;
declare const __VIBE_LIVE_HOST_WRITES__: boolean;
/** Default-off VM2 remote execution authority; VM0 Auth/API remains independent. */
declare const __VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED__: boolean;
/** Development-only UA-1 exact-page action; store/default builds are false. */
declare const __VIBE_PILOT_UA1_DISCOVERY_ENABLED__: boolean;
/** Unpacked-build-only Field Lab; store/default builds are false. */
declare const __VIBE_EXTENSION_FIELD_LAB_ENABLED__: boolean;
/** Local-rehearsal-only connected panel; store/default/Field Lab builds are false. */
declare const __VIBE_EXTENSION_CONNECTED_DEV_ENABLED__: boolean;
/** Explicit private staging artifact only; never store/default/Field Lab. */
declare const __VIBE_EXTENSION_CONNECTED_STAGING_ENABLED__: boolean;
/** Exact-page, expiring, unpacked-only write rehearsal. False in every ordinary artifact. */
declare const __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__: boolean;
declare const __VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__: string | null;
declare const __VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__: string | null;
declare const __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__: number;
/** Approved local-only tuple and fixed window; absent in all other artifacts. */
declare const __VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__: string | null;
declare const __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__: number;

declare const __VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__: boolean;
/** ATS lab build only (VIBE_DIST=ats-lab). Never true in any shippable artifact. */
declare const __VIBE_ATS_LAB__: boolean;
/** 这份产物怎么打的（store、unpacked、local……，lib/buildConfig.ts 的 resolveBuildFlavor）；随版本号一起上报。 */
declare const __VIBE_BUILD_FLAVOR__: string;
