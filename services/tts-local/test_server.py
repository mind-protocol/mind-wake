"""Tests sans GPU ni modèle : moteurs simulés. python -m unittest services/tts-local/test_server.py"""

import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


class FakeEngine:
    def __init__(self, name="fake", fail=False):
        self.name, self.fail, self.calls = name, fail, []

    def synthesize(self, voice, text, lang):
        self.calls.append((voice["id"], text, lang))
        if self.fail:
            raise RuntimeError("GPU absent")
        return b"\x01\x00" * 1600, 16000


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.reg = server.load_registry()
        self.tmp = Path(tempfile.mkdtemp())

    def test_every_agent_resolves_by_id_alias_or_name(self):
        r = lambda a: server.resolve_voice(a, self.reg, self.tmp)  # noqa: E731
        self.assertEqual(r("vox")["id"], "vox")
        self.assertEqual(r("@VOX")["id"], "vox")
        self.assertEqual(r("room-7")["id"], "vox")
        self.assertEqual(r("Équinoxe")["id"], "coach-colony-4")
        self.assertEqual(r("aldebaran")["id"], "coach-telegram-6")
        self.assertEqual(r("Coach des coachs")["id"], "coach-des-coachs")
        unknown = r("quelqu-un")
        self.assertEqual((unknown["id"], unknown["matched"]), ("default", False))
        coaches = [v for v in self.reg["voices"] if v.startswith("coach-colony") or v.startswith("coach-telegram")]
        self.assertEqual(len(coaches), 18)

    def test_reference_is_used_once_frozen(self):
        self.assertIsNone(server.resolve_voice("vox", self.reg, self.tmp)["reference"])
        ref = self.tmp / "tts-local" / "voices" / "vox.wav"
        ref.parent.mkdir(parents=True)
        ref.write_bytes(b"RIFF")
        self.assertEqual(server.resolve_voice("vox", self.reg, self.tmp)["reference"], str(ref))

    def test_split_text(self):
        chunks = server.split_text("Une phrase. " * 60)
        self.assertTrue(all(len(c) <= server.CHUNK_CHARS for c in chunks))
        self.assertEqual(" ".join(chunks).count("Une phrase."), 60)
        self.assertTrue(all(len(c) <= 50 for c in server.split_text("mot " * 100, limit=50)))


class SynthTest(unittest.TestCase):
    def test_falls_back_to_next_engine(self):
        gpu, cpu = FakeEngine("qwen3-tts", fail=True), FakeEngine("piper")
        s = server.Synthesizer(Path(tempfile.mkdtemp()), engines=[gpu, cpu])
        audio, engine, voice = s.synth("Bonjour.", "marco")
        self.assertEqual((engine, voice["id"]), ("piper", "marco"))
        self.assertEqual(audio[:4], b"RIFF")
        with self.assertRaises(ValueError):
            s.synth("  ", "marco")
        with self.assertRaises(RuntimeError):
            server.Synthesizer(Path(tempfile.mkdtemp()), engines=[]).synth("x", "vox")

    def test_http_endpoints(self):
        s = server.Synthesizer(Path(tempfile.mkdtemp()), engines=[FakeEngine()])
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(s))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_port}"
        try:
            self.assertTrue(json.load(urllib.request.urlopen(base + "/health"))["ok"])
            self.assertEqual(json.load(urllib.request.urlopen(base + "/voice/Orion"))["id"], "coach-telegram")
            req = urllib.request.Request(base + "/synth", data=json.dumps({"agent": "vox", "text": "Salut."}).encode(), headers={"content-type": "application/json"})
            with urllib.request.urlopen(req) as res:
                self.assertEqual(res.headers["x-tts-voice"], "vox")
                with wave.open(io.BytesIO(res.read())) as w:
                    self.assertEqual(w.getframerate(), 16000)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
