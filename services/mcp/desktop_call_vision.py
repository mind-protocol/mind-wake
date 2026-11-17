"""Mirror observation results to the local calls their author is participating in."""
import base64
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import unicodedata


def active_calls(root, room):
    path = root / "mobile-call-control.sqlite"
    if not path.is_file():
        return set()
    member = os.environ.get("MIND_WAKE_OWNER_AGENT", "")
    signature = os.environ.get("MIND_WAKE_OWNER_SIGNATURE", "").strip()
    name = re.sub(r"\(.*\)", "", signature).strip().lower()
    name = "".join(c for c in unicodedata.normalize("NFD", name) if not unicodedata.combining(c))
    handle = re.sub("[^a-z0-9]+", "-", name).strip("-")
    handles = {member, handle} - {""}
    if not member and str(room or 1) != "1":
        handles.add(f"room{room}")
    elif not member and not signature:
        handles.add("mind")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute("SELECT id,participants FROM call_control_sessions WHERE state='active' AND last_seen>=?",
                          (int(time.time()*1000)-120000,))
        return {call for call, participants in rows if handles.intersection(json.loads(participants))}


def record(root, calls, req, response):
    calls = calls.intersection(active_calls(root, req.get("room")))
    if not calls:
        return
    author = os.environ.get("MIND_WAKE_OWNER_SIGNATURE") or os.environ.get("MIND_WAKE_OWNER_AGENT") or (
        "Marco" if str(req.get("room") or 1) == "1" else f"Room {req['room']}")
    for item in response if isinstance(response, list) else [response]:
        if not isinstance(item, dict):
            continue
        payload = {k:item[k] for k in ("grid_text","diff","changes","changed","region","row","column") if k in item}
        jpeg = item.get("jpeg") or item.get("_vision_jpeg")
        if not jpeg and item.get("capture") and (payload or item.get("rows")) and item.get("changed") is not False:
            from PIL import Image
            import io
            path = Path(req["cache"]) / item["capture"] / "screen.png"
            if path.is_file():
                with Image.open(path) as im:
                    buf = io.BytesIO()
                    im.convert("RGB").save(buf, "JPEG", quality=72)
                    jpeg = base64.b64encode(buf.getvalue()).decode("ascii")
        if not jpeg and not payload:
            continue
        if jpeg:
            payload["jpeg"] = jpeg
        target = req["args"].get("window") or item.get("title") or item.get("window") or "Bureau"
        with closing(sqlite3.connect(root / "desktop-vision.sqlite", timeout=2)) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS call_frames(id INTEGER PRIMARY KEY, call TEXT,
                at INTEGER, author TEXT, target TEXT, payload TEXT)""")
            db.execute("CREATE INDEX IF NOT EXISTS call_frames_cursor ON call_frames(call,id)")
            now = int(time.time()*1000)
            db.execute("DELETE FROM call_frames WHERE at<?", (now-86400000,))
            data = json.dumps(payload, ensure_ascii=False)
            for call in calls:
                db.execute("INSERT INTO call_frames(call,at,author,target,payload) VALUES(?,?,?,?,?)",
                           (call, now, author, str(target), data))
                db.execute("""DELETE FROM call_frames WHERE call=? AND id NOT IN
                    (SELECT id FROM call_frames WHERE call=? ORDER BY id DESC LIMIT 24)""", (call, call))
