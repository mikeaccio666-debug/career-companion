import asyncio
import gzip
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, web

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
from protocol import TranscriptionError
from server import Supervisor, create_app

FIXTURE = SERVICE / "tests/fixtures/worker.py"


def multipart(parts=None):
    boundary = "synthetic-fixture-boundary"
    if parts is None:
        parts = [("model", b"whisper-tiny", None), ("file", b"audio", "audio/wav")]
    chunks = []
    for name, value, mime in parts:
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'.encode())
        if mime:
            chunks.append(b'; filename="synthetic.wav"\r\nContent-Type: ' + mime.encode())
        chunks.append(b"\r\n\r\n" + value + b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


async def until(check, timeout=4):
    async with asyncio.timeout(timeout):
        while not check():
            await asyncio.sleep(0.01)


class ObservedSupervisor(Supervisor):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cleanup_entered = asyncio.Event()

    async def _terminate(self, process):
        self.cleanup_entered.set()
        await super()._terminate(process)


class SupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="synthetic-transcription-")
        self.assets = Path(self.directory.name)
        self.supervisor = ObservedSupervisor(self.assets, timeout=0.25, worker=FIXTURE)
        self.supervisor.begin_start()
        await until(self.supervisor.is_ready)

    async def asyncTearDown(self):
        self.supervisor.closing = True
        await self.supervisor.stop()
        self.directory.cleanup()

    async def test_binary_frame_single_concurrency_timeout_reap_reload(self):
        old = self.supervisor.process
        pending = asyncio.create_task(self.supervisor.transcribe(b"slow"))
        await until(lambda: (self.assets / "started").exists())
        with self.assertRaises(TranscriptionError) as busy:
            await self.supervisor.transcribe(b"audio")
        self.assertEqual(busy.exception.code, "LOCAL_TRANSCRIPTION_BUSY")
        with self.assertRaises(TranscriptionError) as timeout:
            await pending
        self.assertEqual(timeout.exception.code, "LOCAL_TRANSCRIPTION_TIMEOUT")
        self.assertEqual(old.returncode, -9)
        await until(self.supervisor.is_ready)
        self.assertNotEqual(self.supervisor.process.pid, old.pid)
        self.assertEqual(await self.supervisor.transcribe(b"audio"), {"text": "Synthetic fixture transcript."})

    async def cancelled_cleanup(self, audio):
        old = self.supervisor.process
        pending = asyncio.create_task(self.supervisor.transcribe(audio))
        await asyncio.wait_for(self.supervisor.cleanup_entered.wait(), 3)
        owned = self.supervisor.cleanup_task
        self.assertIs(self.supervisor.process, old)
        pending.cancel()
        await asyncio.sleep(0)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(owned.done())
        self.assertEqual(old.returncode, -9)
        await until(self.supervisor.is_ready)
        self.assertEqual(await self.supervisor.transcribe(b"audio"), {"text": "Synthetic fixture transcript."})

    async def test_repeated_cancel_during_timeout_cleanup(self):
        await self.cancelled_cleanup(b"slow")

    async def test_repeated_cancel_during_invalid_frame_cleanup(self):
        await self.cancelled_cleanup(b"malformed")

    async def test_shutdown_joins_cleanup_and_prevents_reload(self):
        self.supervisor.timeout = 10
        old = self.supervisor.process
        pending = asyncio.create_task(self.supervisor.transcribe(b"slow"))
        await until(lambda: (self.assets / "started").exists())
        pending.cancel()
        await asyncio.wait_for(self.supervisor.cleanup_entered.wait(), 3)
        self.supervisor.closing = True
        shutdown = asyncio.create_task(self.supervisor.stop())
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        await asyncio.wait_for(shutdown, 3)
        self.assertTrue(self.supervisor.cleanup_task.done())
        self.assertEqual(old.returncode, -9)
        self.assertIsNone(self.supervisor.process)


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="synthetic-transcription-http-")
        self.assets = Path(self.directory.name)
        self.supervisor = ObservedSupervisor(self.assets, timeout=10, worker=FIXTURE)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        self.port = listener.getsockname()[1]
        self.runner = web.AppRunner(create_app(self.supervisor, self.port), handler_cancellation=True, access_log=None)
        await self.runner.setup()
        self.site = web.SockSite(self.runner, listener)
        await self.site.start()
        self.client = ClientSession()
        self.base = f"http://127.0.0.1:{self.port}"
        await until(self.supervisor.is_ready)

    async def asyncTearDown(self):
        await self.client.close()
        await self.runner.cleanup()
        self.directory.cleanup()

    async def post(self, body, headers):
        async with self.client.post(self.base + "/v1/audio/transcriptions", data=body, headers=headers) as response:
            return response.status, await response.json()

    async def test_file_before_after_model_and_rejected_transport_headers(self):
        for parts in [None, [("file", b"audio", "audio/wav"), ("model", b"whisper-tiny", None)]]:
            status, result = await self.post(*multipart(parts))
            self.assertEqual(status, 200)
            self.assertEqual(result, {"text": "Synthetic fixture transcript."})
        body, headers = multipart()
        status, _result = await self.post(body.replace(b"Content-Disposition:", b"content-disposition:").replace(b"Content-Type:", b"content-type:"), headers)
        self.assertEqual(status, 200)
        for extra, status in [({"Origin": "http://localhost:3000"}, 403), ({"Host": "evil.invalid"}, 403),
                              ({"Content-Encoding": "identity"}, 415), ({"Content-Encoding": "gzip"}, 415),
                              ({"Content-Type": "application/json"}, 415)]:
            data = gzip.compress(body) if extra.get("Content-Encoding") == "gzip" else body
            actual, result = await self.post(data, {**headers, **extra})
            self.assertEqual(actual, status)
            self.assertNotIn(str(self.assets), json.dumps(result))
        self.assertEqual((self.assets / "request-count").read_text(), "3")

    async def test_duplicate_unknown_nested_or_truncated_parts_never_forwarded(self):
        valid = [("model", b"whisper-tiny", None), ("file", b"audio", "audio/wav")]
        cases = [valid + [("model", b"whisper-tiny", None)], valid + [("file", b"audio", "audio/wav")],
                 [("_charset_", b"UTF-8", None)] + valid, valid + [("prompt", b"synthetic", None)],
                 [("model", b"other", None), valid[1]], [valid[0]],
                 [("model", b"whisper-tiny", None), ("file", b"audio", "multipart/mixed")]]
        for index, parts in enumerate(cases):
            status, _result = await self.post(*multipart(parts))
            self.assertEqual(status, 400, f"case {index}")
        body, headers = multipart()
        status, _result = await self.post(body[:-10], headers)
        self.assertEqual(status, 400)
        self.assertFalse((self.assets / "request-count").exists())

    async def test_file_size_and_chunked_preamble_wire_bounds(self):
        with patch("server.MAX_AUDIO_BYTES", 3):
            status, _result = await self.post(*multipart())
            self.assertEqual(status, 413)
        body, headers = multipart()

        async def oversized():
            for _ in range(20):
                yield b"synthetic preamble\r\n" * 5
            yield body

        with patch("server.MAX_HTTP_BYTES", 1024):
            status, _result = await self.post(oversized(), headers)
            self.assertEqual(status, 413)
        self.assertFalse((self.assets / "request-count").exists())

    async def test_real_disconnect_reaps_worker_and_new_request_succeeds(self):
        old = self.supervisor.process
        _reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        body, headers = multipart([("model", b"whisper-tiny", None), ("file", b"slow", "audio/wav")])
        writer.write((f"POST /v1/audio/transcriptions HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Type: {headers['Content-Type']}\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body)
        await writer.drain()
        await until(lambda: (self.assets / "started").exists())
        self.assertEqual(int((self.assets / "started").read_text()), old.pid)
        status, _result = await self.post(*multipart())
        self.assertEqual(status, 429)
        writer.close()
        await writer.wait_closed()
        await asyncio.wait_for(self.supervisor.cleanup_entered.wait(), 3)
        await until(lambda: old.returncode is not None)
        self.assertEqual(old.returncode, -9)
        await until(self.supervisor.is_ready)
        self.assertTrue(self.supervisor.cleanup_task.done())
        status, _result = await self.post(*multipart())
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
