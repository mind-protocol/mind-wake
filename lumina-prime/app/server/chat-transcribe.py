"""Bounded, local audio transcription for the mobile gateway (one request at a time)."""
import glob
import io
import json
import os
import sys
import time

# Short mono clips use small matrices. Large BLAS thread pools delay other gateway work.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
import av
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps

RATE = 16000
MAX_SECONDS = 65
vad = VadOptions(min_silence_duration_ms=500, speech_pad_ms=160)


def speech_samples(data):
    # Decode once, bounded before concatenating even when duration metadata is absent.
    chunks = []
    samples = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
    with av.open(io.BytesIO(data)) as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            frame.pts = None
            for part in resampler.resample(frame):
                samples += part.samples
                if samples > MAX_SECONDS * RATE:
                    raise ValueError("audio_too_long")
                chunks.append(part.to_ndarray().ravel())
        chunks.extend(part.to_ndarray().ravel() for part in resampler.resample(None))
    if not chunks:
        raise ValueError("empty_audio")
    audio = np.concatenate(chunks).astype(np.float32) / 32768
    if len(audio) > MAX_SECONDS * RATE:
        raise ValueError("audio_too_long")
    spans = get_speech_timestamps(audio, vad)
    speech = np.concatenate([audio[s["start"]:s["end"]] for s in spans]) if spans else audio[:0]
    return speech, len(audio) / RATE


def load_model(device):
    return WhisperModel(sys.argv[1], device=device, compute_type="float16" if device == "cuda" else "int8",
                        local_files_only=True, cpu_threads=1)


def main():
    dlls = []
    directories = [d for base in sys.path for d in glob.glob(os.path.join(base, "nvidia", "*", "bin"))]
    if os.name == "nt":
        import ctypes
        folder = ctypes.create_unicode_buffer(260)
        ctypes.windll.shell32.SHGetFolderPathW(None, 28, None, 0, folder)
        ollama = os.path.join(folder.value, "Programs", "Ollama", "lib", "ollama", "cuda_v12")
        if os.path.isfile(os.path.join(ollama, "cublas64_12.dll")):
            directories.insert(0, ollama)
    for directory in directories:
        os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            dlls.append(os.add_dll_directory(directory))
    requested = sys.argv[2]
    device = "cpu" if requested == "cpu" else "cuda"
    try:
        model = load_model(device)
    except Exception:
        device = "cpu"
        model = load_model(device)
    source = sys.stdin.buffer
    while header := source.read(4):
        size = int.from_bytes(header, "big")
        if len(header) != 4 or not 0 < size <= 4 * 1024 * 1024:
            break
        data = source.read(size)
        if len(data) != size:
            break
        started = time.monotonic()
        try:
            audio, duration = speech_samples(data)
            text = ""
            if len(audio):
                def recognize():
                    # argv[3] : vocabulaire du profil (stt-vocabulary.json), biais natif faster-whisper.
                    options = {"hotwords": sys.argv[3]} if len(sys.argv) > 3 and sys.argv[3] else {}
                    segments, _ = model.transcribe(audio, beam_size=5, **options)
                    return " ".join(segment.text.strip() for segment in segments).strip()
                try:
                    text = recognize()
                except RuntimeError:
                    if device == "cpu":
                        raise
                    device = "cpu"
                    model = load_model(device)
                    text = recognize()
            if len(text) > 4000:
                raise ValueError("transcript_too_long")
            result = {"text": text, "durationSeconds": duration, "speechSeconds": len(audio) / RATE,
                      "device": device, "processingMs": round(1000 * (time.monotonic() - started))}
        except Exception:
            result = {"error": "transcription_failed"}
        print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
