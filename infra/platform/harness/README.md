# Trusted Codex harness image

This image packages Node 24, pinned official `@openai/codex@0.144.4` and the reviewed [stdio wrapper](../../../packages/ai-core/src/relay-wrapper.mjs). It contains no model credentials. The executor inspects the locally installed image ID and starts it with `--pull=never`; it never builds or installs a harness while executing a user job.

From the workspace root:

```sh
node infra/platform/harness/build.mjs
PLATFORM_TEST_REAL_HARNESS=1 PLATFORM_TEST_CLI_EXTERNAL_SANDBOX=1 \
  pnpm --filter @companion/ai-core test
```

The build helper uses a temporary context containing only `Dockerfile` and `relay-wrapper.mjs`. Never use the workspace root as this image's Docker context: it can contain local credentials and user material. Building downloads the Node base image if absent and the pinned CLI package from npm; this installs software and does not call a model. Updates require reviewing the pinned CLI version, rebuilding and rerunning compatibility tests. The base image tag is not digest-pinned, so a production build must additionally pin and audit its base digest and dependency provenance.

The optional integration test runs real Docker and the official CLI but serves invented Responses in the host callback. It checks that the CLI's command tool writes a real `fixture.ts` with the expected contents and that the executor returns its bytes. No API key or commercial provider gate is needed. The fake response helper is exported at [codex-responses.ts](../../../packages/ai-core/test/fixtures/codex-responses.ts). A fake model succeeding does not establish production model quality, API availability or costs.

On the tested macOS/Colima runtime, Codex's default bubblewrap sandbox cannot create a user namespace. An attempt with the older Landlock feature also did not produce a file. The fixture therefore uses an explicit test opt-in which sets server `PLATFORM_CLI_EXTERNAL_SANDBOX=1` and server argv `--sandbox danger-full-access`. The executor requires that opt-in for a sandbox-bypass command. The default server argv remains `workspace-write`; it does not silently retry with fewer restrictions. With the opt-in, Docker alone isolates filesystem execution: `network=none`, read-only root and input, private output bind, non-root UID, capability drop, no-new-privileges, nonexecutable `/tmp`, process/memory/CPU limits and no Docker socket are all retained. Do not run the external-sandbox command directly on the host. OpenAI documents external container isolation in its [security guide](https://learn.chatgpt.com/docs/agent-approvals-security).

Docker must see the task bind directory on the daemon host. The real fixture uses the ignored workspace `.local/harness-fixtures` directory because macOS private temporary directories are not always shared by Colima. The tested synthetic bind preserves worker UID 501 and mode 0700; the runner does not make user material world-writable. A remote Docker daemon needs a suitable directory on that same host. See [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

For a real platform task, configure `PLATFORM_ENABLE_CLI`, image, server command, `PLATFORM_CLI_MODEL_RELAY=1` and server model. The platform API separately requires identity, approval, current lease, provider-call gate, server credential and task/daily budget. The wrapper's Responses-compatible listener exists only on container loopback. All model bytes travel over Docker stdin/stdout to the worker's `requestModel`; the container stays disconnected and does not receive a provider key. Custom provider controls are documented in the official [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). OpenCode model relay is not implemented.

The container is an execution boundary, not a complete hosted sandbox service. Production requires a dedicated worker, audited image, filesystem/project quota, artifact retention and Docker-daemon access controls. The application file monitor is a soft aggregate limit. Public deployment and paid model calls have not been verified by these fixtures. Detailed bounds and cancellation handling are in [ai-core README](../../../packages/ai-core/README.md).
