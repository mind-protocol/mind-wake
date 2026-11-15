"""Local speech recognition. No remote inference and no implicit model download."""
import json
import sys
import argparse
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("audio")
parser.add_argument("model")
parser.add_argument("--allow-empty", action="store_true")
parser.add_argument("--hotwords", default=None)
args = parser.parse_args()
model = WhisperModel(args.model, device="cpu", compute_type="int8", local_files_only=True)
segments, info = model.transcribe(args.audio, beam_size=5, vad_filter=True, **({"hotwords": args.hotwords} if args.hotwords else {}))
text = " ".join(segment.text.strip() for segment in segments).strip()
if not text and not args.allow_empty:
    raise RuntimeError("Aucune parole reconnue")
print(json.dumps({"text": text, "language": info.language}, ensure_ascii=True))
