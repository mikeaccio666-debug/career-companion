import asyncio
import gzip
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
import wave

from aiohttp import ClientSession, web

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
from protocol import MAX_BODY_BYTES, SpeechError, parse_request
from server import Supervisor, create_app

FIXTURE = SERVICE / "tests/fixtures/worker.py"


def payload(text="Audio"):
    return {"model": "kokoro-82m", "input": text, "voice": "af_heart", "response_format": "wav"}


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


class ProtocolTests(unittest.TestCase):
    def test_fixed_schema_and_script_bounds(self):
        self.assertEqual(parse_request(json.dumps(payload("Fictional résumé practice.")).encode()), "Fictional résumé practice.")
        for item in [payload("中文"), payload("a" * 4001), payload("\x00"), payload("\ud800"),
                     {**payload(), "model": ["kokoro-82m"]}, {**payload(), "path": "/private"}]:
            with self.assertRaises(SpeechError):
                parse_request(json.dumps(item).encode())

    def test_duplicate_invalid_json_and_bounded_bytes(self):
        for body in [b'{"input":"Audio","input":"Other"}', b"NaN", b"[]", b"\xff"]:
            with self.assertRaises(SpeechError):
                parse_request(body)
        with self.assertRaises(SpeechError) as raised:
            parse_request(b" " * (MAX_BODY_BYTES + 1))
        self.assertEqual(raised.exception.status, 413)


class SupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="synthetic-local-speech-")
        self.assets = Path(self.directory.name)
        self.supervisor = ObservedSupervisor(self.assets, timeout=0.25, worker=FIXTURE)
        self.supervisor.begin_start()
        await until(self.supervisor.is_ready)

    async def asyncTearDown(self):
        self.supervisor.closing = True
        await self.supervisor.stop()
        self.directory.cleanup()

    async def test_single_concurrency_and_timeout_reaps_then_reloads(self):
        old = self.supervisor.process
        pending = asyncio.create_task(self.supervisor.synthesize("Slow"))
        await until(lambda: (self.assets / "started").exists())
        with self.assertRaises(SpeechError) as busy:
            await self.supervisor.synthesize("Audio")
        self.assertEqual(busy.exception.code, "LOCAL_SPEECH_BUSY")
        with self.assertRaises(SpeechError) as expired:
            await pending
        self.assertEqual(expired.exception.code, "LOCAL_SPEECH_TIMEOUT")
        self.assertEqual(old.returncode, -9)
        await until(self.supervisor.is_ready)
        self.assertNotEqual(self.supervisor.process.pid, old.pid)
        self.assertGreater(len(await self.supervisor.synthesize("Audio")), 44)

    async def cancelled_cleanup(self, text):
        old = self.supervisor.process
        pending = asyncio.create_task(self.supervisor.synthesize(text))
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
        self.assertIsNot(self.supervisor.process, old)
        self.assertGreater(len(await self.supervisor.synthesize("Audio")), 44)

    async def test_second_cancellation_during_timeout_cleanup(self):
        await self.cancelled_cleanup("Slow")

    async def test_second_cancellation_during_protocol_error_cleanup(self):
        await self.cancelled_cleanup("Malformed")

    async def test_shutdown_joins_owned_cleanup_without_restart(self):
        self.supervisor.timeout = 10
        old = self.supervisor.process
        pending = asyncio.create_task(self.supervisor.synthesize("Slow"))
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
        self.assertFalse(self.supervisor.is_ready())


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="synthetic-local-speech-http-")
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

    async def test_real_http_wave_health_and_rejected_headers(self):
        async with self.client.get(self.base + "/health") as response:
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())["weightsVerified"])
        async with self.client.post(self.base + "/v1/audio/speech", json=payload()) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_type, "audio/wav")
            with wave.open(io.BytesIO(await response.read())) as source:
                self.assertEqual((source.getnchannels(), source.getframerate(), source.getsampwidth()), (1, 24000, 2))
        for headers, status in [({"Origin": "http://localhost:3000"}, 403),
                                ({"Host": "evil.invalid"}, 403),
                                ({"Content-Type": "text/plain"}, 415),
                                ({"Content-Type": "application/json", "Content-Encoding": "gzip"}, 415),
                                ({"Content-Type": "application/json", "Content-Encoding": "identity"}, 415)]:
            body = json.dumps(payload()).encode()
            if headers.get("Content-Encoding") == "gzip":
                body = gzip.compress(body)
            async with self.client.post(self.base + "/v1/audio/speech", data=body, headers=headers) as response:
                self.assertEqual(response.status, status)
                body = await response.json()
                self.assertEqual(set(body), {"error"})
                self.assertNotIn(str(self.assets), json.dumps(body))
        self.assertEqual((self.assets / "request-count").read_text(), "1")

    async def test_invalid_request_not_forwarded_and_startup_not_ready(self):
        for body, status in [(' {"model":"kokoro-82m","model":"kokoro-82m"}', 400),
                             (json.dumps({**payload(), "extra": True}), 400),
                             (" " * (MAX_BODY_BYTES + 1), 413)]:
            async with self.client.post(self.base + "/v1/audio/speech", data=body, headers={"Content-Type": "application/json"}) as response:
                self.assertEqual(response.status, status)
        self.supervisor.ready = False
        async with self.client.get(self.base + "/health") as response:
            self.assertEqual(response.status, 503)
            self.assertFalse((await response.json())["weightsVerified"])

    async def test_real_client_disconnect_reaps_child_before_reload(self):
        old = self.supervisor.process
        _reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        body = json.dumps(payload("Slow")).encode()
        writer.write((f"POST /v1/audio/speech HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body)
        await writer.drain()
        await until(lambda: (self.assets / "started").exists())
        self.assertEqual(int((self.assets / "started").read_text()), old.pid)
        writer.close()
        await writer.wait_closed()
        await asyncio.wait_for(self.supervisor.cleanup_entered.wait(), 3)
        await until(lambda: old.returncode is not None)
        self.assertEqual(old.returncode, -9)
        await until(self.supervisor.is_ready)
        self.assertIsNot(self.supervisor.process, old)
        self.assertTrue(self.supervisor.cleanup_task.done())
        async with self.client.post(self.base + "/v1/audio/speech", json=payload()) as response:
            self.assertEqual(response.status, 200)


if __name__ == "__main__":
    unittest.main()
