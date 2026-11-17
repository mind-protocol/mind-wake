"""Local speech recognition. No remote inference and no implicit model download.

Device: `--device auto` (default) uses CUDA only when ctranslate2 sees a GPU *and* cuBLAS 12 is
loadable (pip wheel nvidia-cublas-cu12 or PATH); otherwise the historical CPU/int8 path. On CUDA
the larger `--gpu-model` (default large-v3) is used if it is already in the local cache, else the
configured model. Any CUDA failure falls back to CPU with the configured model.
"""
import argparse
import glob
import json
import os
import sys
import time

# Names Whisper mangled before (Claude Cod, Bacel, 11labs, Mindway, 3,9010 Ti).
DEFAULT_PROMPT = (
    "Vocabulaire : MIND, MindWake, Claude Code, Codex, VOX, Bassel, ElevenLabs, Suno, 3090 Ti, "
    "Telegram, Colony, staking, airdrop. Coachs : Orion, Vega, Altaïr, Sirius, Rigel, Aldébaran, "
    "Polaris, Deneb, Capella, Arcturus, Zénith, Méridien, Solstice, Équinoxe, Horizon, Prisme, "
    "Céleste, Astrolabe."
)

env = os.environ.get
parser = argparse.ArgumentParser()
parser.add_argument("audio")
parser.add_argument("model")
parser.add_argument("--allow-empty", action="store_true")
parser.add_argument("--hotwords", default=None)
parser.add_argument("--device", default=env("MIND_WAKE_STT_DEVICE", "auto"), choices=["auto", "cpu", "cuda"])
parser.add_argument("--compute-type", default=env("MIND_WAKE_STT_COMPUTE_TYPE"))
parser.add_argument("--gpu-model", default=env("MIND_WAKE_STT_GPU_MODEL", "large-v3"))
parser.add_argument("--language", default=env("MIND_WAKE_STT_LANGUAGE", "fr"), help="'auto' = detection")
parser.add_argument("--initial-prompt", default=env("MIND_WAKE_STT_PROMPT", DEFAULT_PROMPT), help="'' = none")
args = parser.parse_args()


def expose_cuda_dlls():
    """pip CUDA wheels (nvidia-*-cu12) put their DLLs in site-packages/nvidia/*/bin."""
    for base in sys.path:
        for d in glob.glob(os.path.join(base, "nvidia", "*", "bin")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(d)


def cuda_usable():
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() < 1:
            return False
        expose_cuda_dlls()
        if os.name == "nt":
            import ctypes
            ctypes.WinDLL("cublas64_12.dll")
        return True
    except Exception:
        return False


def run(model_name, device, compute_type):
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device=device, compute_type=compute_type, local_files_only=True)
    options = {"beam_size": 5, "vad_filter": True}
    if args.hotwords:
        options["hotwords"] = args.hotwords
    if args.initial_prompt:
        options["initial_prompt"] = args.initial_prompt
    if args.language and args.language != "auto":
        options["language"] = args.language
    segments, info = model.transcribe(args.audio, **options)
    return " ".join(segment.text.strip() for segment in segments).strip(), info


started = time.time()
result = None
if args.device == "cuda" or (args.device == "auto" and cuda_usable()):
    if args.device == "cuda":
        expose_cuda_dlls()
    compute = args.compute_type or "float16"
    for name in [n for n in (args.gpu_model, args.model) if n]:
        try:
            result = (*run(name, "cuda", compute), "cuda", compute, name)
            break
        except Exception as error:
            print(f"cuda/{name}: {error}", file=sys.stderr)
if result is None:
    compute = args.compute_type if args.device == "cpu" and args.compute_type else "int8"
    result = (*run(args.model, "cpu", compute), "cpu", compute, args.model)

text, info, device, compute, used = result
if not text and not args.allow_empty:
    raise RuntimeError("Aucune parole reconnue")
print(json.dumps({
    "text": text, "language": info.language, "device": device, "compute_type": compute,
    "model": os.path.basename(used.rstrip("/\\")), "seconds": round(time.time() - started, 2),
}, ensure_ascii=True))
