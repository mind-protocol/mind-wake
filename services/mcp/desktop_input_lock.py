"""Cross-process FIFO lock for desktop input (click, type, scroll, virtual desktop switch).

Every desktop worker is a short-lived Python process spawned by an MCP server, so the
queue lives in a SQLite file of the data directory shared by all rooms. Callers take a
ticket and act in ticket order; others wait up to ``wait`` seconds. A holder or waiter
whose process died, or whose heartbeat stopped, is removed so a crash never blocks
the desktop. On timeout the error names the current holder.

A caller may also hold a control lease on a slot (a room's desktop, or a shared virtual
desktop such as desktop 1) for LEASE_SECONDS after its last action, so its next action
is not interleaved with another agent's. A queued caller blocked by another owner's
lease keeps its place and waits; the lease holder, and callers of other slots, pass.
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
# Control reservation of a slot after its owner's last action.
LEASE_SECONDS = 20.0


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
    if "slot" not in {row[1] for row in db.execute("PRAGMA table_info(queue)")}:
        try:
            db.execute("ALTER TABLE queue ADD COLUMN slot INTEGER")
        except sqlite3.OperationalError:
            pass  # added concurrently
    db.execute("CREATE TABLE IF NOT EXISTS lease (slot INTEGER PRIMARY KEY, owner TEXT, name TEXT, room TEXT,"
               " expires REAL NOT NULL)")
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


def describe_lease(slot, row, now):
    name, room, expires = row
    target = f"bureau virtuel {-slot}" if slot < 0 else f"bureau de la room {slot}"
    where = f" (room {room})" if room not in (None, "") else ""
    return (f"canal de contrôle du {target} réservé par {name or 'un autre agent Wake'}{where}"
            f" encore {max(0, expires - now):.0f} s")


class DesktopInputLock:
    def __init__(self, path=None, owner=None, room=None, tool=None, wait=WAIT_SECONDS, alive=pid_alive, slot=None):
        self.path = Path(path) if path else default_path()
        owner = owner or {}
        self.owner, self.name = owner.get("id"), owner.get("name")
        self.room = None if room is None else str(room)
        self.tool, self.wait, self.alive = tool, wait, alive
        # Lease slot taken and renewed by this call; None for read-only live views.
        self.slot = slot
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
                "INSERT INTO queue (pid,owner,name,room,tool,enqueued,heartbeat,slot) VALUES (?,?,?,?,?,?,?,?)",
                (os.getpid(), self.owner, self.name, self.room, self.tool, now, now, self.slot)).lastrowid)
            deadline = time.monotonic() + self.wait
            while True:
                def step():
                    now = time.time()
                    _purge(db, now, self.alive)
                    db.execute("UPDATE queue SET heartbeat=? WHERE ticket=?", (now, self.ticket))
                    rows = db.execute("SELECT ticket,owner,slot,acquired FROM queue ORDER BY ticket").fetchall()
                    if any(row[3] for row in rows):
                        return False
                    leases = dict(db.execute("SELECT slot,owner FROM lease WHERE expires>?", (now,)).fetchall())
                    # First caller in ticket order not blocked by another owner's lease.
                    head = next((row[0] for row in rows
                                 if row[2] is None or leases.get(row[2], row[1]) == row[1]), None)
                    if head != self.ticket:
                        return False
                    db.execute("UPDATE queue SET acquired=? WHERE ticket=?", (now, self.ticket))
                    if self.slot is not None:
                        db.execute("INSERT OR REPLACE INTO lease VALUES (?,?,?,?,?)",
                                   (self.slot, self.owner, self.name, self.room, now + LEASE_SECONDS))
                    return True
                if self._tx(db, step):
                    break
                if time.monotonic() >= deadline:
                    def give_up():
                        db.execute("DELETE FROM queue WHERE ticket=?", (self.ticket,))
                        lease = None if self.slot is None else db.execute(
                            "SELECT name,room,expires FROM lease WHERE slot=? AND owner IS NOT ? AND expires>?",
                            (self.slot, self.owner, time.time())).fetchone()
                        columns = "SELECT ticket,pid,name,room,tool,enqueued,acquired FROM queue"
                        held = db.execute(columns + " WHERE acquired IS NOT NULL").fetchone()
                        ahead = db.execute(columns + " WHERE ticket<? ORDER BY ticket", (self.ticket,)).fetchall()
                        return lease, held, ahead
                    lease, held, ahead = self._tx(db, give_up)
                    self.ticket = None
                    now = time.time()
                    parts = []
                    if lease:
                        parts.append(describe_lease(self.slot, lease, now))
                    if held:
                        parts.append(describe(held, now))
                    if not parts:
                        parts.append(describe(ahead[0], now) if ahead else "un appel qui vient de se terminer")
                    holder = " ; ".join(parts)
                    queued = f" ; {len(ahead)} appel(s) arrivé(s) avant celui-ci" if ahead else ""
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
            def done():
                if self.slot is not None:
                    # The reservation runs from the end of the action.
                    db.execute("UPDATE lease SET expires=? WHERE slot=? AND owner IS ?",
                               (time.time() + LEASE_SECONDS, self.slot, self.owner))
                db.execute("DELETE FROM queue WHERE ticket=?", (self.ticket,))
            self._tx(db, done)
        finally:
            db.close()
            self.ticket = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_):
        self.release()
