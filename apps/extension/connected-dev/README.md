# Connected-development rehearsal

This artifact contains the approved P1 original-Profile currentness integration
behind a local, default-off gate. It is not a
store build, production activation, or permission to write on an arbitrary
live job application. Host writes remain code-disabled until a team-controlled
exact canary and the UA-5 certification gates are approved.

## 1. Start the local API

The API deliberately refuses to boot outside Node 24. Start from an existing,
approved local API environment with its database and Auth secrets already
configured; never copy those secrets into this repository or a bug report.
Add the following non-secret gates to that local environment:

```text
NODE_ENV=development
PORT=8787
AGENT_BEARER_SUBJECT_OWNER_ADMISSION_ENABLED=true
AGENT_PROFILE_V2_ENABLED=true
AGENT_PROFILE_V2_SCHEMA_STATE=candidate-profile-v2-schema-ready
AGENT_PROFILE_V2_RELEASE_STATE=candidate-profile-v2-release-approved
AGENT_PILOT_UA5_PROFILE_PAYLOADS_ENABLED=true
AGENT_PILOT_UA5_PROFILE_PAYLOADS_STATE=pilot-ua5-profile-payload-v2-connected-dev
```

P1 also requires the existing validated execution signing configuration:
`EXECUTION_INTENT_ACTIVE_KID`, `EXECUTION_INTENT_PRIVATE_KEY_PKCS8`, and
`EXECUTION_INTENT_JWKS_PUBLIC_KEYS`. Use the environment's approved key custody;
do not paste key material here. P1 uses a dedicated original-binding JWS type
and purpose, and does not issue Auth or ExecutionIntent tokens. Missing or
invalid configuration keeps both Profile endpoints disabled.

Then run:

```sh
pnpm --filter @edaix/api start:dev
curl --fail --silent http://localhost:8787/health/live
```

The Panel uses `/health/live` only to prove that the fixed local API process is
reachable. Neither API health route proves that the Profile schema, owner
snapshot, or payload capability is ready; those remain separate authenticated,
fail-closed gates. If `/health/live` cannot connect, the Product Panel reports
the local API as unavailable and does not start a run.

## 2. Connect the account

Open the local development Portal at `https://edaix.io:8443`, sign in as the
test account, and complete the Extension connection flow yourself. The account
must own a ready Profile V2 snapshot. Passwords, tokens, Profile values, and
screenshots must not be pasted into logs or committed.

## 3. Build and load the artifact

```sh
pnpm --filter @edaix/extension check:connected-dev-artifact
```

In `chrome://extensions`, enable Developer mode and load:

```text
apps/extension/.output-connected-dev/chrome-mv3
```

Chrome must show **EdAIX Connected Lab (Unpacked Dev)**. The first visit to a
matched Greenhouse page can show **Access requested**; granting that site
permission is a user action, and the page should then be refreshed once.

If Chrome also lists **EdAIX Job Agent** or another EdAIX build, that is a
separate extension identity. Do not grant or use the other build during this
rehearsal: two page-reading or autofill extensions would make the result
ambiguous. Select only **EdAIX Connected Lab (Unpacked Dev)**.

## 4. Current boundary

The Panel may diagnose the fixed local API, account connection, exact page
registration, Profile/capability readiness, and live-write authorization using
only closed value-free states. A public job page such as an employer's ordinary
Greenhouse posting is not a team-controlled canary and must remain zero-write.
The Extension never clicks or invokes Submit.

The payload endpoint now requires outer schema version 2 and a fresh run ID.
The inner payload remains version 1. Each leaf requires a same-ordinal page
grant followed by authenticated `/api/v1/agent/pilot/ua5/profile-currentness`
(schema version 1). The original seal stays private to background memory.
A match proves one current read, not an atomic transaction with a later DOM
setter. Token/fetch/body share a five-second budget bounded by the original
run and authority deadlines. Both private port names and transport are v2;
unload/reload the paired build and refresh content pages when changing versions.
Never replay an old run or fall back to a writer without currentness evidence.

The checked-in live-write source gate remains false. Final-head technical review,
controlled real-page acceptance, and environment release are separate gates.
Undo and automatic restoration remain frozen; inspect already-filled fields
in the host page after a failed run or a paired-version rollback.
