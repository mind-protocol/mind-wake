"""Same installed faster-whisper engine as Telegram, bounded owner-initiated clips only."""
import json
import sys
import av
from faster_whisper import WhisperModel

audio, model_path = sys.argv[1:3]
seconds = 0.0
with av.open(audio) as container:
    if not container.streams.audio:
        raise RuntimeError("no_audio")
    stream = container.streams.audio[0]
    for frame in container.decode(stream):
        if not frame.sample_rate:
            raise RuntimeError("invalid_audio")
        seconds += frame.samples / frame.sample_rate
        if seconds > 65:
            raise RuntimeError("audio_too_long")
if seconds <= 0:
    raise RuntimeError("empty_audio")
model = WhisperModel(model_path, device="cpu", compute_type="int8", local_files_only=True)
segments, info = model.transcribe(audio, beam_size=5, vad_filter=True)
text = " ".join(segment.text.strip() for segment in segments).strip()
if len(text) > 4000:
    raise RuntimeError("transcript_too_long")
print(json.dumps({"text": text, "language": info.language, "durationSeconds": seconds}, ensure_ascii=True))
