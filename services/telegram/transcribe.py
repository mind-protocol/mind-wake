"""Local speech recognition. No remote inference and no implicit model download."""
import json
import sys
from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[2], device="cpu", compute_type="int8", local_files_only=True)
segments, info = model.transcribe(sys.argv[1], beam_size=5, vad_filter=True)
text = " ".join(segment.text.strip() for segment in segments).strip()
if not text and "--allow-empty" not in sys.argv:
    raise RuntimeError("Aucune parole reconnue")
print(json.dumps({"text": text, "language": info.language}, ensure_ascii=True))
