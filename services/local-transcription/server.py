"""Loopback HTTP supervisor. Only one model process/request; cancellation reaps it."""
import argparse
import asyncio
import contextlib
import json
import logging
import os
from pathlib import Path
import sys
import warnings

from aiohttp import BodyPartReader, MultipartReader, web
from aiohttp.multipart import parse_content_disposition
from protocol import MAX_AUDIO_BYTES, MAX_HTTP_BYTES, MAX_JSON_BYTES, MAX_TEXT_BYTES, MODEL, MIME_TYPES, MESSAGES, TranscriptionError, error_body, result_bytes

SERVICE = Path(__file__).resolve().parent


class Supervisor:
    def __init__(self, assets: Path, timeout: float = 90, startup_timeout: float = 60,
                 worker: Path = SERVICE / "worker.py"):
        self.assets = assets.resolve()
        self.timeout = timeout
        self.startup_timeout = startup_timeout
        self.worker = worker
        self.process = None
        self.start_task = None
        self.cleanup_task = None
        self.ready = False
        self.closing = False
        self.blocked = False
        self.lock = asyncio.Lock()

    def is_ready(self):
        return self.ready and self.process is not None and self.process.returncode is None and not self.blocked

    def begin_start(self):
        if not self.closing and not self.blocked and (self.start_task is None or self.start_task.done()):
            self.start_task = asyncio.create_task(self._start())

    async def _terminate(self, process):
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 0.5)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except asyncio.TimeoutError:
                    self.blocked = True
                    raise TranscriptionError("LOCAL_TRANSCRIPTION_CLEANUP_UNCONFIRMED", 503) from None
        if process.stdin is not None:
            process.stdin.close()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                try:
                    await asyncio.wait_for(process.stdin.wait_closed(), 1)
                except asyncio.TimeoutError:
                    self.blocked = True
                    raise TranscriptionError("LOCAL_TRANSCRIPTION_CLEANUP_UNCONFIRMED", 503) from None

    async def _start(self):
        process = None
        try:
            # Do not inherit host API keys, tokens, proxies or other environment secrets.
            environment = {"PATH": os.defpath, "LANG": "C.UTF-8", "HF_HUB_OFFLINE": "1",
                           "HF_DATASETS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                           "HF_HOME": str(self.assets.parent / "offline-cache"), "TRANSFORMERS_OFFLINE": "1",
                           "TOKENIZERS_PARALLELISM": "false", "OMP_NUM_THREADS": "4",
                           "PYTHONDONTWRITEBYTECODE": "1"}
            process = await asyncio.create_subprocess_exec(sys.executable, str(self.worker), "--assets", str(self.assets),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                env=environment, limit=1024)
            self.process = process
            header = await asyncio.wait_for(process.stdout.readline(), self.startup_timeout)
            data = json.loads(header)
            if data != {"event": "ready", "weightsVerified": True}:
                raise TranscriptionError("LOCAL_TRANSCRIPTION_NOT_READY", 503)
            self.ready = True
        except (Exception, asyncio.CancelledError):
            self.ready = False
            terminated = True
            if process is not None:
                try:
                    await self._terminate(process)
                except TranscriptionError:
                    self.blocked = True
                    terminated = False
            if terminated and self.process is process:
                self.process = None

    async def _stop_owned(self):
        self.ready = False
        if self.start_task is not None and not self.start_task.done():
            self.start_task.cancel()
            await self.start_task
        process = self.process
        if process is not None:
            await self._terminate(process)
            if self.process is process:
                self.process = None

    async def _cleanup(self, restart):
        try:
            await self._stop_owned()
        except Exception:
            self.blocked = True
            raise
        if restart:
            self.begin_start()

    async def _wait_cleanup(self, task):
        # The supervisor retains ownership through repeated HTTP cancellations.
        # Only the bounded terminate/kill deadline, never the client, ends cleanup.
        cancelled = False
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                cancelled = True
        task.result()
        if cancelled:
            raise asyncio.CancelledError()

    async def stop(self):
        self.ready = False
        if self.cleanup_task is None or self.cleanup_task.done():
            self.cleanup_task = asyncio.create_task(self._cleanup(False))
        await self._wait_cleanup(self.cleanup_task)

    async def recycle(self):
        self.ready = False
        if self.cleanup_task is None or self.cleanup_task.done():
            self.cleanup_task = asyncio.create_task(self._cleanup(True))
        await self._wait_cleanup(self.cleanup_task)

    async def transcribe(self, audio: bytes) -> dict:
        if not audio or len(audio) > MAX_AUDIO_BYTES:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_BODY_TOO_LARGE", 413)
        if not self.is_ready():
            raise TranscriptionError("LOCAL_TRANSCRIPTION_NOT_READY", 503)
        if self.lock.locked():
            raise TranscriptionError("LOCAL_TRANSCRIPTION_BUSY", 429)
        async with self.lock:
            process = self.process
            try:
                async with asyncio.timeout(self.timeout):
                    process.stdin.write(json.dumps({"bytes": len(audio)}).encode() + b"\n")
                    await process.stdin.drain()
                    # Bounded binary framing; no base64 expansion or audio in headers.
                    for offset in range(0, len(audio), 64 * 1024):
                        process.stdin.write(audio[offset:offset + 64 * 1024])
                        await process.stdin.drain()
                    header = json.loads(await process.stdout.readline())
                    if "error" in header:
                        code = header["error"]
                        if code not in MESSAGES or header.get("status") not in (400, 413, 502, 503):
                            raise ValueError()
                        raise TranscriptionError(code, header["status"])
                    size = header.get("bytes")
                    if set(header) != {"bytes"} or isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= MAX_JSON_BYTES:
                        raise ValueError()
                    result = json.loads(await process.stdout.readexactly(size))
                    result_bytes(result)
                    return result
            except asyncio.CancelledError:
                await self.recycle()
                raise
            except TimeoutError:
                await self.recycle()
                raise TranscriptionError("LOCAL_TRANSCRIPTION_TIMEOUT", 504) from None
            except TranscriptionError:
                raise
            except Exception:
                await self.recycle()
                raise TranscriptionError("LOCAL_TRANSCRIPTION_FAILED", 502) from None


class StrictMultipartReader(MultipartReader):
    def _get_part_reader(self, headers):
        # Reject hidden _charset_ fields before aiohttp's special first-part handling.
        allowed = {"content-disposition", "content-type"}
        if any(key.lower() not in allowed or len(headers.getall(key)) != 1 for key in headers):
            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
        disposition, params = parse_content_disposition(headers.get("Content-Disposition", ""))
        if disposition != "form-data" or params.get("name") not in {"model", "file"}:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
        if set(params) - {"name", "filename", "filename*"}:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
        if headers.get("Content-Type", "").lower().startswith("multipart/"):
            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
        return super()._get_part_reader(headers)


class BoundedStream:
    """Count consumed multipart bytes too, including chunked preamble and headers."""
    def __init__(self, source):
        self.source = source
        self.consumed = 0

    def count(self, data):
        self.consumed += len(data)
        if self.consumed > MAX_HTTP_BYTES:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_BODY_TOO_LARGE", 413)
        return data

    async def read(self, size=-1):
        # Multipart only requests finite chunks; never expose an unbounded read.
        if size < 0:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
        return self.count(await self.source.read(size))

    async def readline(self, *, max_line_length=8190):
        return self.count(await self.source.readline(max_line_length=max_line_length))

    def unread_data(self, data):
        self.consumed -= len(data)
        if self.consumed < 0:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
        self.source.unread_data(data)

    def at_eof(self):
        return self.source.at_eof()


async def parse_upload(request):
    if request.content_length is not None and request.content_length > MAX_HTTP_BYTES:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_BODY_TOO_LARGE", 413)
    try:
        reader = StrictMultipartReader(request.headers, BoundedStream(request.content), client_max_size=MAX_HTTP_BYTES,
                                       max_field_size=1024, max_headers=8)
        seen = set()
        audio = None
        async with asyncio.timeout(15):
            async for part in reader:
                if not isinstance(part, BodyPartReader) or part.name in seen or part.name not in {"model", "file"}:
                    raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
                seen.add(part.name)
                if part.name == "model":
                    if part.filename is not None:
                        raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
                    value = bytearray()
                    while chunk := await part.read_chunk():
                        value.extend(chunk)
                        if len(value) > 100:
                            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
                    if value.decode("utf-8") != MODEL:
                        raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
                else:
                    mime = part.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    if mime not in MIME_TYPES or not part.filename or len(part.filename) > 255:
                        raise TranscriptionError("LOCAL_TRANSCRIPTION_CONTENT_TYPE", 415)
                    audio = bytearray()
                    while chunk := await part.read_chunk(64 * 1024):
                        audio.extend(chunk)
                        if len(audio) > MAX_AUDIO_BYTES:
                            raise TranscriptionError("LOCAL_TRANSCRIPTION_BODY_TOO_LARGE", 413)
        if seen != {"model", "file"} or not audio:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT")
        return bytes(audio)
    except TranscriptionError:
        raise
    except TimeoutError:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_TIMEOUT", 408) from None
    except Exception:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_INPUT") from None


def create_app(supervisor: Supervisor, port: int) -> web.Application:
    @web.middleware
    async def guard(request, handler):
        try:
            if "Origin" in request.headers:
                raise TranscriptionError("LOCAL_TRANSCRIPTION_ORIGIN_REJECTED", 403)
            hosts = request.headers.getall("Host", [])
            if len(hosts) != 1 or hosts[0] not in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}:
                raise TranscriptionError("LOCAL_TRANSCRIPTION_HOST_REJECTED", 403)
            return await handler(request)
        except TranscriptionError as error:
            return web.json_response(error_body(error), status=error.status, headers={"Cache-Control": "no-store"})
        except web.HTTPException as error:
            code = "LOCAL_TRANSCRIPTION_BODY_TOO_LARGE" if error.status == 413 else "LOCAL_TRANSCRIPTION_INVALID_INPUT"
            return web.json_response(error_body(TranscriptionError(code, error.status)), status=error.status)
        except Exception:
            return web.json_response(error_body(TranscriptionError("LOCAL_TRANSCRIPTION_FAILED", 502)), status=502)

    app = web.Application(client_max_size=MAX_HTTP_BYTES, middlewares=[guard],
                          handler_args={"auto_decompress": False})
    upload_lock = asyncio.Lock()

    async def health(_request):
        ready = supervisor.is_ready()
        return web.json_response({"ready": ready, "model": MODEL, "multilingual": True,
            "device": "cpu", "computeType": "int8", "vad": "silero", "maxDurationSeconds": 120,
            "weightsVerified": ready, "offline": True, "concurrency": 1},
            status=200 if ready else 503, headers={"Cache-Control": "no-store"})

    async def transcription(request):
        content_types = request.headers.getall("Content-Type", [])
        if len(content_types) != 1 or request.content_type != "multipart/form-data":
            raise TranscriptionError("LOCAL_TRANSCRIPTION_CONTENT_TYPE", 415)
        if "Content-Encoding" in request.headers:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_CONTENT_TYPE", 415)
        if not supervisor.is_ready():
            raise TranscriptionError("LOCAL_TRANSCRIPTION_NOT_READY", 503)
        if upload_lock.locked() or supervisor.lock.locked():
            raise TranscriptionError("LOCAL_TRANSCRIPTION_BUSY", 429)
        # Reserve the upload too: concurrent 20 MiB bodies do not form a memory queue.
        async with upload_lock:
            audio = await parse_upload(request)
            result = await supervisor.transcribe(audio)
            return web.Response(body=result_bytes(result), content_type="application/json",
                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    async def start(_app):
        supervisor.begin_start()

    async def stop(_app):
        supervisor.closing = True
        await supervisor.stop()

    app.router.add_get("/health", health)
    app.router.add_post("/v1/audio/transcriptions", transcription)
    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8881)
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    if args.host != "127.0.0.1" or not 1 <= args.port <= 65535 or not 0 < args.timeout <= 120:
        print(json.dumps({"error": {"code": "LOCAL_TRANSCRIPTION_CONFIGURATION_REJECTED", "message": "Use literal 127.0.0.1, a valid port and a bounded deadline."}}))
        raise SystemExit(2)
    logging.disable(logging.CRITICAL)
    warnings.filterwarnings("ignore")
    supervisor = Supervisor(args.assets, timeout=args.timeout)
    web.run_app(create_app(supervisor, args.port), host=args.host, port=args.port,
                handler_cancellation=True, access_log=None, print=None, shutdown_timeout=5)


if __name__ == "__main__":
    main()
