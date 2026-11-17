"""Cross-process FIFO lock for desktop input (click, type, scroll, virtual desktop switch).

Every desktop worker is a short-lived Python process spawned by an MCP server, so the
queue lives in a SQLite file of the data directory shared by all rooms. Callers take a
ticket and act in ticket order; others wait up to ``wait`` seconds. A holder or waiter
whose process died, or whose heartbeat stopped, is removed so a crash never blocks
the desktop. On timeout the error names the current holder.
"""
import ctypes
import os
import sqlite3
import threading
import time
from pathlib import Path

WAIT_SECONDS = 30.0
POLL_SECONDS = 0.05
HEARTBEAT_SECONDS = 1.0
# No heartbeat for this long: the process is frozen or gone.
STALE_SECONDS = 6.0
# Upper bound for one input action, beyond the MCP worker timeout (120 s).
MAX_HOLD_SECONDS = 150.0


class DesktopBusy(ValueError):
    """The desktop stayed held by another caller for the whole waiting period."""


def default_path():
    root = os.environ.get("MIND_WAKE_DATA_DIR")
    if root and Path(root).is_dir():
        return Path(root) / "desktop-input-lock.sqlite"
    import tempfile
    return Path(tempfile.gettempdir()) / "mind-wake-desktop-input-lock.sqlite"


def pid_alive(pid):
    if pid == os.getpid():
        return True
    if os.name == "nt":
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            # Access denied still means the process exists.
            return ctypes.windll.kernel32.GetLastError() == 5
        try:
            code = ctypes.c_ulong()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return not ok or code.value == 259  # STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _connect(path):
    db = sqlite3.connect(str(path), isolation_level=None, timeout=10)
    db.execute("PRAGMA busy_timeout=10000")
    db.execute(
        "CREATE TABLE IF NOT EXISTS queue (ticket INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER NOT NULL,"
        " owner TEXT, name TEXT, room TEXT, tool TEXT, enqueued REAL NOT NULL, heartbeat REAL NOT NULL,"
        " acquired REAL)"
    )
    return db


def _purge(db, now, alive):
    for ticket, pid, heartbeat, acquired in db.execute(
            "SELECT ticket,pid,heartbeat,acquired FROM queue").fetchall():
        if (heartbeat < now - STALE_SECONDS or (acquired and acquired < now - MAX_HOLD_SECONDS)
                or not alive(pid)):
            db.execute("DELETE FROM queue WHERE ticket=?", (ticket,))


def describe(row, now):
    _, pid, name, room, tool, enqueued, acquired = row
    who = name or "un autre agent Wake"
    where = f" (room {room})" if room not in (None, "") else ""
    since = now - (acquired or enqueued)
    state = "détient" if acquired else "attend"
    return f"{who}{where} {state} le bureau pour {tool or 'une action'} depuis {since:.0f} s (pid {pid})"


class DesktopInputLock:
    def __init__(self, path=None, owner=None, room=None, tool=None, wait=WAIT_SECONDS, alive=pid_alive):
        self.path = Path(path) if path else default_path()
        owner = owner or {}
        self.owner, self.name = owner.get("id"), owner.get("name")
        self.room = None if room is None else str(room)
        self.tool, self.wait, self.alive = tool, wait, alive
        self.ticket = None
        self._stop = threading.Event()
        self._beat = None

    def _tx(self, db, fn):
        db.execute("BEGIN IMMEDIATE")
        try:
            result = fn()
            db.execute("COMMIT")
            return result
        except BaseException:
            db.execute("ROLLBACK")
            raise

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = _connect(self.path)
        try:
            now = time.time()
            self.ticket = self._tx(db, lambda: db.execute(
                "INSERT INTO queue (pid,owner,name,room,tool,enqueued,heartbeat) VALUES (?,?,?,?,?,?,?)",
                (os.getpid(), self.owner, self.name, self.room, self.tool, now, now)).lastrowid)
            deadline = time.monotonic() + self.wait
            while True:
                def step():
                    now = time.time()
                    _purge(db, now, self.alive)
                    db.execute("UPDATE queue SET heartbeat=? WHERE ticket=?", (now, self.ticket))
                    head = db.execute("SELECT ticket FROM queue ORDER BY ticket LIMIT 1").fetchone()
                    if head and head[0] == self.ticket:
                        db.execute("UPDATE queue SET acquired=? WHERE ticket=?", (now, self.ticket))
                        return True
                    return False
                if self._tx(db, step):
                    break
                if time.monotonic() >= deadline:
                    def give_up():
                        db.execute("DELETE FROM queue WHERE ticket=?", (self.ticket,))
                        return db.execute(
                            "SELECT ticket,pid,name,room,tool,enqueued,acquired FROM queue"
                            " WHERE ticket<? ORDER BY ticket", (self.ticket,)).fetchall()
                    ahead = self._tx(db, give_up)
                    self.ticket = None
                    now = time.time()
                    holder = describe(ahead[0], now) if ahead else "un appel qui vient de se terminer"
                    queued = f" ; {len(ahead) - 1} autre(s) appel(s) avant celui-ci" if len(ahead) > 1 else ""
                    raise DesktopBusy(
                        f"Bureau occupé depuis plus de {self.wait:.0f} s : {holder}{queued}. Réessayez après son action.")
                time.sleep(POLL_SECONDS)
        except BaseException:
            if self.ticket is not None:
                try:
                    db.execute("DELETE FROM queue WHERE ticket=?", (self.ticket,))
                except sqlite3.Error:
                    pass
                self.ticket = None
            raise
        finally:
            db.close()
        self._beat = threading.Thread(target=self._heartbeat, daemon=True)
        self._beat.start()
        return self

    def _heartbeat(self):
        db = _connect(self.path)
        try:
            while not self._stop.wait(HEARTBEAT_SECONDS):
                try:
                    db.execute("UPDATE queue SET heartbeat=? WHERE ticket=?", (time.time(), self.ticket))
                except sqlite3.Error:
                    pass
        finally:
            db.close()

    def release(self):
        self._stop.set()
        if self._beat:
            self._beat.join(5)
            self._beat = None
        if self.ticket is None:
            return
        db = _connect(self.path)
        try:
            db.execute("DELETE FROM queue WHERE ticket=?", (self.ticket,))
        finally:
            db.close()
            self.ticket = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_):
        self.release()
