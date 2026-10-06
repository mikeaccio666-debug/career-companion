# Local English speech worker

This independent worker synthesizes English with the public Kokoro 82M model on CPU. It returns a completed WAV file; it does not provide speech recognition, realtime audio, Chinese speech, voice cloning or a browser-facing API. The platform backend supplies identity, authorization, job/session ownership and private result storage.

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and Python 3.12 separately, then explicitly prepare the isolated environment and fixed public assets:

```sh
bash services/local-speech/setup.sh
bash services/local-speech/run.sh
```

Setup downloads the locked packages and verifies the SHA-256 hashes in [assets.json](assets.json). It creates `.local/platform/local-speech/.venv` and `.local/platform/local-speech/models`; weights are excluded from source. `LOCAL_SPEECH_STATE_DIR` changes that server-side state directory; `LOCAL_SPEECH_PYTHON` selects an already installed Python 3.12 for setup. Setup never starts the server. Run never installs or downloads anything. Missing or changed assets leave `/health` at 503; fix the explicit setup and restart.

The committed `uv.lock` fixes package versions and wheel hashes. macOS uses the native PyTorch wheel; Linux selects the [official PyTorch CPU index](https://pytorch.org/get-started/locally/) through `tool.uv.sources`, avoiding CUDA packages. Linux needs a supported CPU wheel/platform and glibc (the current eSpeak loader wheels require glibc 2.17 on x86-64 or 2.28 on ARM64). The Python implementation and dependency route support Linux, but only macOS ARM64 CPU execution has been tested here. Python 3.13 is deliberately rejected because the pinned Kokoro/Misaki release requires Python below 3.13.

The server accepts `--host 127.0.0.1` only, `--port` (default 8880), and `--timeout` in seconds (default 90, maximum 120). The default endpoint is `http://127.0.0.1:8880/v1/audio/speech`:

```json
{"model":"kokoro-82m","input":"This is a fictional English practice sentence.","voice":"af_heart","response_format":"wav"}
```

Use UTF-8 `application/json` with these four exact fields. Duplicate keys, unknown fields, compressed bodies, other models/voices/formats, empty input, non-Latin alphabetic characters and control characters are rejected. Input is limited to 4,000 Unicode characters and JSON to 32 KiB. The script restriction is not language detection: Latin-script text can still be outside English or pronounce poorly. Successful responses are `audio/wav`: PCM 16-bit little endian, mono, 24 kHz, maximum 30 MiB. No API key is required or created.

Any `Origin` header is rejected and no CORS headers are issued. `Host` must be a literal `127.0.0.1`, `localhost` or `[::1]` with the actual listening port; the socket itself binds only IPv4 `127.0.0.1`. Call this worker from the trusted platform backend. These HTTP checks are not an OS sandbox or protection from other trusted local processes. Do not expose the port or replace loopback binding with a public interface.

`GET /health` returns 200 only after the child has checked all fixed assets and G2P package contents, loaded the model and voice, and initialized English G2P. It returns 503 during startup, restart or a model failure. Its public metadata includes `ready`, `weightsVerified`, `offline`, `model`, `voice`, `languages`, `device` and `concurrency`; no filesystem paths, prompts, PIDs or keys are returned. Health confirms loaded state, not a fresh inference or pronunciation quality measurement.

Inference runs in one supervised child with an allowlist environment; host keys, proxy variables and credentials are not inherited. The child uses `HF_HUB_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1` and explicit local model/config/voice files. It also disables Python socket connections and DNS lookup before importing inference packages. This is an additional download guard, not a kernel network sandbox. Voice tensors and preinstalled G2P avoid the upstream helpers' automatic downloads. Model and voice deserialization use `weights_only=True`. Production logs do not contain request text; package stdout/stderr is discarded, HTTP access logging is disabled, and failures return a fixed safe JSON error.

Only one generation runs at a time; another request gets 429 instead of joining an unbounded queue. The inference kernel cannot be safely interrupted within a Python thread. On request disconnect, deadline or protocol failure, a supervisor-owned cleanup task terminates the whole child, escalates to SIGKILL if needed, waits for confirmed process exit, then reloads the model. Repeated cancellation and service shutdown join that cleanup rather than losing child ownership. Health is 503 while reloading. Failure to confirm cleanup blocks restart and requires an operator to restart the service. Slow body reads have a separate five-second deadline. The [aiohttp peer-disconnection mechanism](https://docs.aiohttp.org/en/stable/web_advanced.html#peer-disconnection) is explicitly enabled with `handler_cancellation=True`.

Safe error codes distinguish invalid input (400), body/output limits (413), rejected Origin/Host (403), content type (415), concurrency (429), readiness (503), inference timeout (504) and failed generation (502). No raw package exception, text or path is returned.

Run the independent regression tests after preparation:

```sh
PYTHONDONTWRITEBYTECODE=1 .local/platform/local-speech/.venv/bin/python -m unittest discover -s services/local-speech/tests -v
```

These tests use a synthetic framed child and real loopback HTTP sockets, covering schema, hashes, concurrency, deadlines, client disconnection, repeated cancellation, confirmed SIGKILL/reaping and shutdown. They do not call a model. On 2026-10-06, a separate real macOS CPU smoke loaded the verified local Kokoro model with network connections disabled, and actual HTTP synthesis returned a non-silent 5.075-second WAV in approximately 0.8 seconds. The owned Linux CPU development instance later completed Kokoro-to-Whisper synthesis/transcription and a browser played a six-second private Kokoro WAV with `readyState=4` and no decoding error. Evidence and synthetic audio remain in ignored `.local/platform/verification`; see [remote development](../../docs/platform/remote-development.md). These checks prove the short development-host chain and format, not general voice quality, capacity or the target production image.

The [Kokoro library](https://github.com/hexgrad/kokoro) and [fixed Kokoro 82M model revision](https://huggingface.co/hexgrad/Kokoro-82M/tree/f3ff3571791e39611d31c381e3a41a3af07b4987) declare Apache-2.0. [Misaki](https://github.com/hexgrad/misaki) provides English G2P and the [official spaCy English model](https://github.com/explosion/spacy-models/releases/tag/en_core_web_sm-3.8.0) is separately MIT licensed. eSpeak NG and phonemizer dependencies have GPL licenses; their licensing is not replaced by the model's Apache license. Review the complete locked dependency licenses and preserve applicable notices before distributing an image or executable. Voice/model files come from public fixed revisions without a token; no weights are committed.
