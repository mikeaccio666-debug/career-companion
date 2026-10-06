"""Loopback HTTP supervisor. Only one model process/request; cancellation reaps it."""
import argparse
import asyncio
import contextlib
import json
import logging
import os
from pathlib import Path
import sys

from aiohttp import web
from protocol import MAX_BODY_BYTES, MAX_WAV_BYTES, MODEL, VOICE, MESSAGES, SpeechError, error_body, parse_request

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
                    raise SpeechError("LOCAL_SPEECH_CLEANUP_UNCONFIRMED", 503) from None
        if process.stdin is not None:
            process.stdin.close()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                try:
                    await asyncio.wait_for(process.stdin.wait_closed(), 1)
                except asyncio.TimeoutError:
                    self.blocked = True
                    raise SpeechError("LOCAL_SPEECH_CLEANUP_UNCONFIRMED", 503) from None

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
                raise SpeechError("LOCAL_SPEECH_NOT_READY", 503)
            self.ready = True
        except (Exception, asyncio.CancelledError):
            self.ready = False
            terminated = True
            if process is not None:
                try:
                    await self._terminate(process)
                except SpeechError:
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

    async def synthesize(self, text: str) -> bytes:
        if not self.is_ready():
            raise SpeechError("LOCAL_SPEECH_NOT_READY", 503)
        if self.lock.locked():
            raise SpeechError("LOCAL_SPEECH_BUSY", 429)
        async with self.lock:
            process = self.process
            body = json.dumps({"model": MODEL, "input": text, "voice": VOICE, "response_format": "wav"}, ensure_ascii=False).encode() + b"\n"
            try:
                async with asyncio.timeout(self.timeout):
                    process.stdin.write(body)
                    await process.stdin.drain()
                    header = json.loads(await process.stdout.readline())
                    if "error" in header:
                        code = header["error"]
                        if code not in MESSAGES or header.get("status") not in (400, 413, 502, 503):
                            raise ValueError()
                        raise SpeechError(code, header["status"])
                    size = header.get("bytes")
                    if set(header) != {"bytes"} or isinstance(size, bool) or not isinstance(size, int) or size < 46 or size > MAX_WAV_BYTES:
                        raise ValueError()
                    return await process.stdout.readexactly(size)
            except asyncio.CancelledError:
                await self.recycle()
                raise
            except TimeoutError:
                await self.recycle()
                raise SpeechError("LOCAL_SPEECH_TIMEOUT", 504) from None
            except SpeechError:
                raise
            except Exception:
                await self.recycle()
                raise SpeechError("LOCAL_SPEECH_FAILED", 502) from None


def create_app(supervisor: Supervisor, port: int) -> web.Application:
    @web.middleware
    async def guard(request, handler):
        try:
            if "Origin" in request.headers:
                raise SpeechError("LOCAL_SPEECH_ORIGIN_REJECTED", 403)
            hosts = request.headers.getall("Host", [])
            if len(hosts) != 1 or hosts[0] not in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}:
                raise SpeechError("LOCAL_SPEECH_HOST_REJECTED", 403)
            return await handler(request)
        except SpeechError as error:
            return web.json_response(error_body(error), status=error.status, headers={"Cache-Control": "no-store"})
        except web.HTTPException as error:
            code = "LOCAL_SPEECH_BODY_TOO_LARGE" if error.status == 413 else "LOCAL_SPEECH_INVALID_INPUT"
            return web.json_response(error_body(SpeechError(code, error.status)), status=error.status)
        except Exception:
            return web.json_response(error_body(SpeechError("LOCAL_SPEECH_FAILED", 502)), status=502)

    app = web.Application(client_max_size=MAX_BODY_BYTES, middlewares=[guard],
                          handler_args={"auto_decompress": False})

    async def health(_request):
        ready = supervisor.is_ready()
        return web.json_response({"ready": ready, "model": MODEL, "voice": VOICE, "languages": ["en-US"],
            "device": "cpu", "weightsVerified": ready, "offline": True, "concurrency": 1},
            status=200 if ready else 503, headers={"Cache-Control": "no-store"})

    async def speech(request):
        content_types = request.headers.getall("Content-Type", [])
        if len(content_types) != 1 or request.content_type != "application/json" or request.charset not in (None, "utf-8", "UTF-8"):
            raise SpeechError("LOCAL_SPEECH_CONTENT_TYPE", 415)
        if "Content-Encoding" in request.headers:
            raise SpeechError("LOCAL_SPEECH_CONTENT_TYPE", 415)
        try:
            body = await asyncio.wait_for(request.read(), 5)
        except TimeoutError:
            raise SpeechError("LOCAL_SPEECH_TIMEOUT", 408) from None
        text = parse_request(body)
        audio = await supervisor.synthesize(text)
        return web.Response(body=audio, content_type="audio/wav", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    async def start(_app):
        supervisor.begin_start()

    async def stop(_app):
        supervisor.closing = True
        await supervisor.stop()

    app.router.add_get("/health", health)
    app.router.add_post("/v1/audio/speech", speech)
    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8880)
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    if args.host != "127.0.0.1" or not 1 <= args.port <= 65535 or not 0 < args.timeout <= 120:
        print(json.dumps({"error": {"code": "LOCAL_SPEECH_CONFIGURATION_REJECTED", "message": "Use literal 127.0.0.1, a valid port and a bounded deadline."}}))
        raise SystemExit(2)
    logging.disable(logging.CRITICAL)
    supervisor = Supervisor(args.assets, timeout=args.timeout)
    web.run_app(create_app(supervisor, args.port), host=args.host, port=args.port,
                handler_cancellation=True, access_log=None, print=None, shutdown_timeout=5)


if __name__ == "__main__":
    main()
