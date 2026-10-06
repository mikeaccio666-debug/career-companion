/** New product keys generated locally during migration. Public only; no private key is persisted. */
/**
 * The ordinary (non-store) package's identity.
 *
 * Chrome derives an unpacked extension's id from its manifest key, and without
 * one the id follows the directory path: a different extension on every machine
 * and after every move. Nothing that pins an id can then match it -- not a
 * portal's configured app id, not an API's allowed extension origins -- so the
 * ordinary artifact carries a fixed public key and always installs as the same
 * extension.
 *
 * This is a **public** key and it is meant to be in the repository: it is the
 * manifest key, readable in any installed copy. The matching private key was
 * never generated for signing and is not held anywhere; this pins an identity,
 * it does not authenticate one.
 *
 * Store builds never take it. A published item's id belongs to its listing, and
 * `resolveExtensionPublicKey` refuses a store build outright.
 */
export const DEVELOPMENT_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv8cTakPnNMPUyM1aKqfrSxUHyIo/yH7ft1kHmpJgj/T6tzRW3n+UNlX4Yt4ODHQnb1bhcAB/IiWlUyEWYgpb/I0rj5cCaZ1tzd0Fuvm0X8T/dbm6uX2uh/7hm2T5wfSWoa84keuMyVBDiUVRqVpLXcNiMFDkXqvcGhRvn4XbrGdJcctjbT4LSDLIkvehLzMawgQAZjHwmPUzL+Mg0uPdHtazpQwZVbnESsLWsxWlqjojVHn059EGieygN1/R8704wUu9Z1ncBLGSAIccF5t7q9hGo2qS2LFiIvVz2O+jhsCQY9bjtBPuZLKPcArGNoLIbZo0O0bWU0fao2CNgMAIXQIDAQAB";

/** Derived from the key above; asserted by the default-artifact gate. */
export const DEVELOPMENT_EXTENSION_ID = "nnkbfpmgkcfheoonjgfoodmdkiblefbn";

/**
 * The local test package's identity, kept apart from the ordinary one.
 *
 * `VIBE_DIST=local` builds a second, independent extension that talks only to
 * a developer's own backend (`pnpm dev:staging` on this machine). Two unpacked
 * artifacts claiming one id collide the moment both are loaded, and the one
 * that points at production must never be the one that gets replaced by a local
 * test build -- so the local flavour carries its own key and installs beside
 * the ordinary package rather than over it.
 *
 * Public, like the key above: it pins an identity and authenticates nothing.
 */
export const LOCAL_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz/GcybvIG4xKMjvBEtq4WbfQL6SPrkHcv0kE2hzKfer49OYMNfiPj15lVJtlcS5Po7QwC8i7J0DtM12aEfleim4SZ/IDnuzklUoxCoUWf6TvnRwUI4/pOWmHI+/KWt+GxsONnnPWnNHQSf8fL0K5yG/tocb1+zUlfNrOIEbFID0ZPGDr17A6BREDPwj4I1DBVNpxd3Ep2GqOJ21Kn8Un8lzo9Ikts3p7+LHz1QAFQzH+JaL2JV681AryX9lH5d8zmXNfAotsNgg8ijWqcCbRrwPCE9SOh9Sqpsj2TQgg1Zb+j4NqEZdCwtwM8NaQrKueYZCzpchySJr/clK4tm+DmwIDAQAB";

/** Derived from the key above; asserted by the local-artifact gate. */
export const LOCAL_EXTENSION_ID = "koaoegfhnkffpgddghbhjldhaoghchgg";
