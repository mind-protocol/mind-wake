"""Voix locale neuronale de MIND Wake : un serveur HTTP sur 127.0.0.1, une voix par agent.

Moteur principal : Qwen3-TTS (Apache-2.0, poids compris), sur GPU CUDA.
  - Chaque voix est DESSINÉE à partir d'une description texte (modèle VoiceDesign), une seule fois ;
    la référence produite est figée dans <data>/tts-local/voices/<id>.wav (+ .txt), puis le modèle
    Base la reprend à chaque phrase (clonage de cette voix synthétique, jamais d'une personne).
Secours : Piper (CPU), voix de série fr_FR-siwis-medium / en_US-ljspeech-medium.

Commandes :
  python server.py serve  [--port 8766] [--data-dir D]
  python server.py synth  --agent vox --text "Bonjour" --out bonjour.wav [--data-dir D]
  python server.py design --agent vox [--candidates 4]     # propositions à écouter
  python server.py adopt  --agent vox --candidate 2         # fige la voix choisie
  python server.py smoke                                    # appareil + latence

Aucune dépendance lourde n'est importée avant le premier usage du moteur (tests sans GPU).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import sys
import threading
import time
import unicodedata
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICES_FILE = HERE / "voices.json"
DEFAULT_PORT = 8766
MAX_TEXT = 5000
CHUNK_CHARS = 280
LANGS = {"fr": "French", "en": "English", "de": "German", "es": "Spanish", "it": "Italian", "pt": "Portuguese"}
QWEN_DESIGN = os.environ.get("MIND_TTS_DESIGN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
QWEN_BASE = os.environ.get("MIND_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")


def default_data_dir() -> Path:
    env = os.environ.get("MIND_WAKE_DATA_DIR")
    if env:
        return Path(env)
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "mind-wake"


# ---------------------------------------------------------------- registre (même règle que client.mjs)

def voice_key(value) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(c for c in text if unicodedata.category(c) != "Mn").lower().strip().lstrip("@")
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", text))


def load_registry(path: Path = VOICES_FILE) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def resolve_voice(agent, registry: dict, data_dir: Path) -> dict:
    key = voice_key(agent)
    voices = registry["voices"]
    found = None
    if key:
        for vid, v in voices.items():
            if voice_key(vid) == key:
                found = vid
                break
        if not found:
            for vid, v in voices.items():
                if any(voice_key(a) == key for a in v.get("aliases", [])):
                    found = vid
                    break
        if not found:
            for vid, v in voices.items():
                if voice_key(v.get("name")) == key:
                    found = vid
                    break
    vid = found or registry["default"]
    v = voices[vid]
    gender = "male" if v.get("gender") == "male" else "female"
    stored = Path(data_dir) / "tts-local" / "voices" / f"{vid}.wav"
    reference = str((Path(data_dir) / v["reference"]).resolve()) if v.get("reference") else (str(stored) if stored.exists() else None)
    piper = registry.get("fallback", {}).get("piper", {})
    return {
        "id": vid,
        "agentId": str(agent or ""),
        "matched": bool(found),
        "name": v.get("name", vid),
        "gender": gender,
        "lang": v.get("lang", "fr"),
        "instruct": v.get("instruct", ""),
        "refText": v.get("refText", registry.get("refText", "")),
        "reference": reference,
        "piper": v.get("piper", piper.get(gender)),
        "piperEn": piper.get("en"),
    }


# ---------------------------------------------------------------- texte et audio

def split_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """Découpe aux fins de phrase ; une phrase trop longue est coupée aux virgules puis aux espaces."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…;:])\s+", text.strip()) if s.strip()]
    chunks: list[str] = []
    for sentence in sentences:
        parts = [sentence]
        if len(sentence) > limit:
            parts, current = [], ""
            for word in re.split(r"(?<=,)\s+|\s+", sentence):
                if current and len(current) + 1 + len(word) > limit:
                    parts.append(current)
                    current = word
                else:
                    current = f"{current} {word}".strip()
            if current:
                parts.append(current)
        for part in parts:
            if chunks and len(chunks[-1]) + 1 + len(part) <= limit:
                chunks[-1] = f"{chunks[-1]} {part}"
            else:
                chunks.append(part)
    return chunks


def wav_bytes(pcm16: bytes, rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16)
    return out.getvalue()


def to_pcm16(samples) -> bytes:
    import numpy as np

    array = np.asarray(samples, dtype=np.float32).reshape(-1)
    return (np.clip(array, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def silence(rate: int, seconds: float) -> bytes:
    return b"\x00\x00" * int(rate * seconds)


# ---------------------------------------------------------------- moteurs

class QwenEngine:
    """Qwen3-TTS : VoiceDesign pour créer une voix, Base pour la parler (clonage de la référence figée)."""

    name = "qwen3-tts"

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self._design = None
        self._base = None
        self._prompts: dict[str, tuple[float, object]] = {}

    @staticmethod
    def available() -> bool:
        try:
            import torch  # noqa: F401
            import qwen_tts  # noqa: F401

            return torch.cuda.is_available()
        except Exception:
            return False

    def _load(self, repo: str):
        import torch
        from qwen_tts import Qwen3TTSModel

        kwargs = {"device_map": "cuda:0", "dtype": torch.bfloat16}
        try:
            import flash_attn  # noqa: F401

            kwargs["attn_implementation"] = "flash_attention_2"
        except Exception:
            pass  # attention par défaut de transformers (sdpa) : plus de VRAM, même résultat
        return Qwen3TTSModel.from_pretrained(repo, **kwargs)

    def design_model(self):
        if self._design is None:
            self._design = self._load(QWEN_DESIGN)
        return self._design

    def base_model(self):
        if self._base is None:
            self._base = self._load(QWEN_BASE)
        return self._base

    def design(self, voice: dict, out: Path, seed: int = 0) -> Path:
        """Dessine une référence (~10 s) pour cette voix et l'écrit en WAV + texte."""
        import torch

        torch.manual_seed(seed)
        wavs, sr = self.design_model().generate_voice_design(
            text=voice["refText"], language=LANGS.get(voice.get("lang", "fr"), "Auto"), instruct=voice["instruct"]
        )
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(wav_bytes(to_pcm16(wavs[0]), sr))
        out.with_suffix(".txt").write_text(voice["refText"], encoding="utf-8")
        return out

    def _reference(self, voice: dict) -> tuple[str, str]:
        if voice.get("reference") and Path(voice["reference"]).exists():
            ref = Path(voice["reference"])
        else:
            # Première utilisation : la voix est dessinée puis figée, pour rester la même ensuite.
            ref = self.design(voice, self.data_dir / "tts-local" / "voices" / f"{voice['id']}.wav")
        text_file = ref.with_suffix(".txt")
        ref_text = text_file.read_text(encoding="utf-8").strip() if text_file.exists() else voice["refText"]
        return str(ref), ref_text

    def _prompt(self, voice: dict):
        ref, ref_text = self._reference(voice)
        mtime = Path(ref).stat().st_mtime
        cached = self._prompts.get(ref)
        if cached and cached[0] == mtime:
            return cached[1]
        prompt = self.base_model().create_voice_clone_prompt(ref_audio=ref, ref_text=ref_text)
        self._prompts[ref] = (mtime, prompt)
        return prompt

    def synthesize(self, voice: dict, text: str, lang: str) -> tuple[bytes, int]:
        chunks = split_text(text)
        prompt = self._prompt(voice)
        language = LANGS.get(lang, "Auto")
        wavs, sr = self.base_model().generate_voice_clone(
            text=chunks, language=[language] * len(chunks), voice_clone_prompt=prompt
        )
        gap = silence(sr, 0.18)
        return gap.join(to_pcm16(w) for w in wavs), sr


class PiperEngine:
    """Secours CPU : voix Piper de série (pas de voix propre par agent)."""

    name = "piper"

    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir) / "tts-local" / "piper"
        self._voices: dict[str, object] = {}

    def available(self) -> bool:
        try:
            import piper  # noqa: F401

            return any(self.dir.glob("*.onnx"))
        except Exception:
            return False

    def synthesize(self, voice: dict, text: str, lang: str) -> tuple[bytes, int]:
        from piper import PiperVoice

        model = voice.get("piperEn") if lang == "en" and voice.get("piperEn") else voice.get("piper")
        if not model or not (self.dir / f"{model}.onnx").exists():
            raise RuntimeError(f"voix Piper absente : {model}")
        if model not in self._voices:
            self._voices[model] = PiperVoice.load(str(self.dir / f"{model}.onnx"))
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            self._voices[model].synthesize_wav(text, w)
        out.seek(0)
        with wave.open(out, "rb") as r:
            return r.readframes(r.getnframes()), r.getframerate()


class Synthesizer:
    """Choisit le moteur : Qwen sur GPU, sinon Piper. Un seul appel GPU à la fois."""

    def __init__(self, data_dir: Path, engines: list | None = None):
        self.data_dir = Path(data_dir)
        self.registry = load_registry()
        if engines is None:
            engines = []
            if os.environ.get("MIND_TTS_ENGINE", "auto") in ("auto", "qwen") and QwenEngine.available():
                engines.append(QwenEngine(self.data_dir))
            piper = PiperEngine(self.data_dir)
            if piper.available():
                engines.append(piper)
        self.engines = engines
        self.lock = threading.Lock()

    def voice(self, agent=None, spec: dict | None = None) -> dict:
        if spec and spec.get("id") and spec.get("instruct"):
            return spec
        return resolve_voice(agent, self.registry, self.data_dir)

    def synth(self, text: str, agent=None, spec: dict | None = None, lang: str | None = None) -> tuple[bytes, str, dict]:
        text = str(text or "").strip()
        if not text:
            raise ValueError("texte vide")
        if len(text) > MAX_TEXT:
            raise ValueError("texte trop long")
        voice = self.voice(agent, spec)
        lang = lang or voice.get("lang", "fr")
        errors = []
        with self.lock:
            for engine in self.engines:
                try:
                    pcm, rate = engine.synthesize(voice, text, lang)
                    if not pcm:
                        raise RuntimeError("audio vide")
                    return wav_bytes(pcm, rate), engine.name, voice
                except Exception as error:  # moteur suivant
                    errors.append(f"{engine.name}: {str(error)[:160]}")
        raise RuntimeError("aucun moteur : " + (" ; ".join(errors) or "aucun moteur installé"))

    def health(self) -> dict:
        info = {"ok": True, "engines": [e.name for e in self.engines], "device": "cpu"}
        try:
            import torch

            if torch.cuda.is_available():
                info["device"] = "cuda"
                info["gpu"] = torch.cuda.get_device_name(0)
        except Exception:
            pass
        info["ok"] = bool(self.engines)
        return info


# ---------------------------------------------------------------- HTTP (127.0.0.1 seulement)

def make_handler(synth: Synthesizer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _json(self, status: int, body) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._json(200, synth.health())
            if self.path == "/voices":
                return self._json(200, [resolve_voice(v, synth.registry, synth.data_dir) for v in synth.registry["voices"]])
            if self.path.startswith("/voice/"):
                return self._json(200, synth.voice(self.path[len("/voice/"):]))
            return self._json(404, {"error": "inconnu"})

        def do_POST(self):
            if self.path != "/synth":
                return self._json(404, {"error": "inconnu"})
            try:
                length = int(self.headers.get("content-length") or 0)
                if length > 64_000:
                    return self._json(413, {"error": "requête trop grande"})
                body = json.loads(self.rfile.read(length) or b"{}")
                audio, engine, voice = synth.synth(body.get("text"), body.get("agent"), body.get("voice"), body.get("lang"))
            except ValueError as error:
                return self._json(400, {"error": str(error)})
            except Exception as error:
                return self._json(503, {"error": str(error)[:300]})
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(audio)))
            self.send_header("x-tts-engine", engine)
            self.send_header("x-tts-voice", voice["id"])
            self.end_headers()
            self.wfile.write(audio)

    return Handler


def serve(port: int, data_dir: Path) -> None:
    synth = Synthesizer(data_dir)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(synth))
    print(json.dumps({"listening": f"http://127.0.0.1:{port}", **synth.health()}), flush=True)
    server.serve_forever()


# ---------------------------------------------------------------- CLI

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Voix locale MIND Wake")
    parser.add_argument("command", choices=["serve", "synth", "design", "adopt", "smoke"])
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--data-dir", default=str(default_data_dir()))
    parser.add_argument("--agent", default="default")
    parser.add_argument("--text", default="Bonjour, c'est moi. Tu m'entends bien ?")
    parser.add_argument("--lang", default=None)
    parser.add_argument("--out", default="voix.wav")
    parser.add_argument("--candidates", type=int, default=4)
    parser.add_argument("--candidate", type=int, default=1)
    args = parser.parse_args(argv)
    data_dir = Path(args.data_dir)

    if args.command == "serve":
        serve(args.port, data_dir)
        return 0
    if args.command in ("design", "adopt"):
        voice = resolve_voice(args.agent, load_registry(), data_dir)
        folder = data_dir / "tts-local" / "candidates"
        if args.command == "adopt":
            src = folder / f"{voice['id']}-{args.candidate}.wav"
            dst = data_dir / "tts-local" / "voices" / f"{voice['id']}.wav"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            shutil.copyfile(src.with_suffix(".txt"), dst.with_suffix(".txt"))
            print(json.dumps({"adopted": str(dst)}))
            return 0
        engine = QwenEngine(data_dir)
        for n in range(1, args.candidates + 1):
            out = engine.design(voice, folder / f"{voice['id']}-{n}.wav", seed=n)
            print(json.dumps({"candidate": n, "file": str(out)}), flush=True)
        return 0
    synth = Synthesizer(data_dir)
    if args.command == "smoke":
        health = synth.health()
        print(json.dumps(health, ensure_ascii=False), flush=True)
        for agent in ("marco", "vox"):
            start = time.perf_counter()
            audio, engine, voice = synth.synth(args.text, agent, lang=args.lang)
            elapsed = time.perf_counter() - start
            with wave.open(io.BytesIO(audio), "rb") as r:
                seconds = r.getnframes() / r.getframerate()
            out = data_dir / "tts-local" / f"smoke-{voice['id']}.wav"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(audio)
            print(json.dumps({"agent": agent, "engine": engine, "latency_s": round(elapsed, 2), "audio_s": round(seconds, 2), "file": str(out)}), flush=True)
        return 0
    audio, engine, voice = synth.synth(args.text, args.agent, lang=args.lang)
    Path(args.out).write_bytes(audio)
    print(json.dumps({"engine": engine, "voice": voice["id"], "out": args.out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
