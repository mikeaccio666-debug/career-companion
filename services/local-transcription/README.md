# Local transcription worker

This independent service transcribes uploaded audio with the multilingual Whisper tiny model through faster-whisper and CTranslate2 on CPU. It returns one completed JSON transcript, including an empty transcript for silence. It does not provide realtime/WebRTC, diarization, translation, text generation or a public browser-facing endpoint. The platform backend remains responsible for identity, authorization, session ownership and private storage; users should review transcripts before using them as instructions.

## Explicit preparation and serving

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and Python 3.12 separately. From the workspace root:

```sh
bash services/local-transcription/setup.sh
bash services/local-transcription/run.sh
```

Setup creates `.local/platform/local-transcription/.venv` and `models`, downloads the locked packages and fixed public model assets, and verifies the SHA-256 hashes in [assets.json](assets.json). Model assets total approximately 78.2 MB and are excluded from source. `LOCAL_TRANSCRIPTION_STATE_DIR` changes the server-side state directory; `LOCAL_TRANSCRIPTION_PYTHON` selects an already installed Python 3.12. Setup never starts the server. Run never installs or downloads anything. Fixed model/tokenizer/VAD failures leave `/health` at 503; repair through explicit setup and restart.

The committed `uv.lock` pins faster-whisper 1.2.1, CTranslate2 4.8.2, PyAV 16.0.1 and their dependencies and wheel hashes. The selected model is **multilingual tiny**, not English-only `tiny.en`; Hugging Face revision `d90ca5fe260221311c53c58e660288d3deb8d356` is fixed. The packaged Silero VAD v6 ONNX file is also pinned by size and hash, checked and loaded before readiness. No VAD downloads occur during requests. This service uses no CUDA package installation or GPU. [CTranslate2's official wheels](https://opennmt.net/CTranslate2/installation.html) support macOS ARM64 and Linux x86-64/AArch64; compatibility still depends on the selected Python/OS wheel (the pinned Linux CTranslate2 wheels require glibc 2.27/2.28). Actual short CPU inference has been verified on macOS ARM64 and the owned Linux development instance. A subsequent real Chrome MediaRecorder check sent a 230,772-byte WebM from a synthetic Kokoro stream to remote Faster Whisper and appended its transcription without replacing the original draft. See [remote development](../../docs/platform/remote-development.md) and [recording verification](../../docs/platform/verification.md#浏览器录音的完成失败与取消); these checks do not prove arbitrary recordings, real phones, production-image compatibility or capacity.

The server accepts `--host 127.0.0.1` only, `--port` (default 8881), and `--timeout` seconds (default 90, maximum 120). No API key is required or created. The platform adapter configuration uses `FASTER_WHISPER_BASE_URL=http://127.0.0.1:8881/v1` and `FASTER_WHISPER_MODEL=whisper-tiny`; provider id is `faster-whisper`.

## Private HTTP contract

`POST /v1/audio/transcriptions` requires uncompressed `multipart/form-data` with exactly two fields, in either order:

| Field | Value |
| --- | --- |
| `model` | `whisper-tiny` |
| `file` | One audio file with a supported audio MIME type |

There is no `response_format`, prompt, language override, user path, URL or selectable remote model field. Duplicate/unknown fields, nested multipart, hidden `_charset_` fields, extra part headers and truncated requests are rejected. The original filename is ignored after a bounded presence check; it is neither passed to the decoder nor saved or logged. File MIME essence must be one of `audio/wav`, `audio/x-wav`, `audio/wave`, `audio/mpeg`, `audio/mp4`, `audio/webm`, `audio/ogg`, `audio/flac`. MIME alone does not prove that bytes are valid audio.

Input file bytes are limited to 20 MiB, total consumed multipart bytes to 20 MiB plus 64 KiB (including chunked preamble/headers), and upload elapsed time to 15 seconds. Real audio decoding uses PyAV's bundled FFmpeg through a `BytesIO` input, fixed demuxer and protocol allowlists, one audio stream and no video streams. Caller paths/URLs and secondary file/network protocols are unavailable to the decoder. Each decoded frame is checked and resampled to mono 16 kHz; decoded samples are counted before accumulation and rejected above 120 seconds. Channels are limited to mono/stereo and source sample rates to 8–192 kHz. Invalid/native decoder errors return a fixed safe error.

The successful response is exactly `{"text":"..."}` with UTF-8 JSON and `Cache-Control: no-store`; empty text is valid. Text is limited to 64 KiB in UTF-8, JSON to 128 KiB, including escaping overhead. No model confidence, raw segments, metadata or original audio is returned. Model-generated words can still be wrong or hallucinated; VAD and silence tests reduce one failure mode without proving accuracy for arbitrary recordings, languages, accents or noise.

Any `Origin` or `Content-Encoding` header is rejected. HTTP auto-decompression is disabled and no CORS headers are emitted. `Host` must be literal `127.0.0.1`, `localhost` or `[::1]` with the actual listening port; the socket binds only IPv4 `127.0.0.1`. The worker is intended only for backend calls. Local HTTP guards are not an OS sandbox and do not protect against trusted local processes with filesystem/process access. Never expose the worker port publicly.

`GET /health` returns 200 only after the child has verified and loaded the fixed model, local tokenizer and packaged VAD. It returns 503 during startup/reload/failure. Public fields describe `ready`, `weightsVerified`, `offline`, fixed `model`, multilingual model capability, CPU/int8, VAD, concurrency and duration limit. Health is not a fresh quality or inference test; multilingual weights do not prove every language has been tested.

## Offline execution and cleanup

The child receives an allowlist environment with `HF_HUB_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`, local model directory and `local_files_only=True`. Python socket connections/DNS are disabled before imports as an extra guard against helper downloads; this is not OS-level network isolation. FFmpeg secondary-resource access is constrained separately by decoder format/protocol allowlists. Package stdout/stderr is discarded; HTTP access logs and warnings are disabled, and responses never contain raw decoder/model exceptions, paths, audio or host credentials.

There is one upload and inference at a time; concurrent requests receive 429 rather than entering a queue. Audio crosses child stdio as a bounded JSON length header plus raw binary chunks, with no base64 expansion, client paths or original filenames. The child returns a bounded JSON frame. Native decoding/inference kernels cannot be safely interrupted in a Python thread. On HTTP disconnect, elapsed deadline or invalid IPC, a supervisor-owned cleanup task terminates the child, escalates to SIGKILL if necessary, confirms process exit, and reloads. Repeated cancellations and shutdown join the same cleanup task, retaining process ownership. Health stays 503 during reload; unconfirmed cleanup blocks restart and requires an operator. Sample count limits are not native memory/CPU sandbox guarantees; single concurrency and process deadlines provide the practical local bounds. [aiohttp peer-disconnection cancellation](https://docs.aiohttp.org/en/stable/web_advanced.html#peer-disconnection) is explicitly enabled.

Safe JSON error codes distinguish invalid input/audio (400), transport type (415), upload/duration/output limits (413), Origin/Host (403), concurrency (429), readiness/cleanup (503), elapsed inference deadline (504) and internal failure (502). Upload deadline is 408. No automatic paid-provider fallback exists.

## Verification and sources

```sh
PYTHONDONTWRITEBYTECODE=1 .local/platform/local-transcription/.venv/bin/python -m unittest discover -s services/local-transcription/tests -v
```

The tests use real PyAV decoding, real loopback HTTP and a synthetic framed child. They cover stereo resampling, decoded duration, secondary-protocol rejection, asset/VAD hashes, UTF-8/JSON budgets, strict multipart, chunked byte limits, concurrency, actual client disconnection, repeated cancellation, confirmed SIGKILL/reaping and shutdown joining cleanup. They do not load a model. A separate 2026-10-06 real offline macOS CPU smoke recognized a synthetic 5.075-second English WAV in 0.483 seconds, with punctuation differences; a 3-second zero PCM WAV returned empty text in 0.113 seconds with local VAD enabled. Initial real HTTP results were also checked. Synthetic inputs and transcripts remain under ignored `.local/platform/verification`; no user microphone was used. Short synthetic fixtures do not establish real-world transcription quality or general throughput.

After the final source restart, actual HTTP English inference took 0.403 seconds and silence returned empty text in 0.122 seconds. A separate 5.943-second fictional Mandarin WAV generated by macOS `say` solely as a test input was recognized in 0.432 seconds; its words matched the intended sentence with traditional-character and punctuation differences. Native `say` is not the product ASR or TTS provider. Actual HTTP rejected a 121-second WAV (413), fake audio bytes (400), gzip body (415) and Origin/invalid Host (403). This validates these specific synthetic fixtures, not general Chinese accuracy or noisy/mixed-language recordings.

The [faster-whisper library](https://github.com/SYSTRAN/faster-whisper), [CTranslate2](https://github.com/OpenNMT/CTranslate2), [fixed Systran converted tiny weights](https://huggingface.co/Systran/faster-whisper-tiny/tree/d90ca5fe260221311c53c58e660288d3deb8d356) and [Silero VAD](https://github.com/snakers4/silero-vad) declare MIT licensing. [PyAV](https://github.com/PyAV-Org/PyAV) is separately BSD-3-Clause and bundles FFmpeg libraries with their own licenses/notices. Preserve and review dependency/FFmpeg third-party notices before distributing an image or executable. Neither all dependency licenses nor voice/model quality are implied by the wrapper's license. This private HTTP wrapper is our implementation, not an official upstream inference server.

The alternative [whisper.cpp](https://github.com/ggml-org/whisper.cpp) also supports lightweight CPU models and macOS/Linux. Its example server permits model-loading paths and configurable inference and its conversion mode invokes system FFmpeg; using that demo directly would require additional boundary work. The selected faster-whisper route reuses the proven process supervisor and provides in-process, bounded PyAV audio decoding without system package installation.
