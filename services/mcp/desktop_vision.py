"""Recent full ASCII observations, independent of each MCP session's diff cache."""
import os
import sqlite3
from contextlib import closing
from pathlib import Path


def save_grid(req, grid, columns, window):
    root = os.environ.get("MIND_WAKE_DATA_DIR")
    if not root:
        return
    room = str(req.get("room") or "1")
    signature = os.environ.get("MIND_WAKE_OWNER_SIGNATURE", "").strip()
    member = os.environ.get("MIND_WAKE_OWNER_AGENT")
    if member:
        agent, label = f"room:{room}:{member}", f"{signature or member} · Room {room}"
    elif room != "1":
        agent, label = f"wake:fork-{room}", signature or f"Fork {room}"
    elif signature == "Coach":
        agent, label = "wake:coach", signature
    elif signature and signature.casefold() != "marco":
        agent, label = f"owner:{signature}", signature
    else:
        client = req.get("visionClient", "").lower()
        engine = ("codex" if "codex" in client else "claude" if "claude" in client else None)
        if not engine and not client:
            engine = "codex" if os.environ.get("CODEX_THREAD_ID") else "claude" if os.environ.get("CLAUDECODE") else None
        agent = f"wake:marco-{engine}" if engine else "owner:Marco"
        label = f"Marco · {engine.capitalize()}" if engine else "Marco · moteur non identifié"
    target = req["args"].get("window") or window or f"Bureau {req.get('desktop') or 'de la room ' + room}"
    with closing(sqlite3.connect(Path(root) / "desktop-vision.sqlite", timeout=2)) as db, db:
        db.execute("""CREATE TABLE IF NOT EXISTS frames (
            id INTEGER PRIMARY KEY, agent TEXT NOT NULL, label TEXT NOT NULL,
            time TEXT NOT NULL, target TEXT NOT NULL, cols INTEGER NOT NULL, grid TEXT NOT NULL)""")
        db.execute("CREATE INDEX IF NOT EXISTS vision_agent ON frames(agent,id)")
        db.execute("""INSERT INTO frames(agent,label,time,target,cols,grid)
            VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?)""",
                   (agent, label, str(target), columns, grid))
        db.execute("""DELETE FROM frames WHERE agent=? AND id NOT IN
            (SELECT id FROM frames WHERE agent=? ORDER BY id DESC LIMIT 12)""", (agent, agent))
