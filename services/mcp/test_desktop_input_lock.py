import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import desktop_input_lock as L

HERE = Path(__file__).resolve().parent

# Child process: take the lock, log enter/exit, hold it `hold` seconds (or crash).
CHILD = r"""
import json, os, sys, time
sys.path.insert(0, sys.argv[1])
from desktop_input_lock import DesktopInputLock, DesktopBusy
path, log, name, hold, wait, mode = sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]), float(sys.argv[6]), sys.argv[7]
def write(event, **extra):
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps(dict(event=event, name=name, t=time.time(), **extra)) + "\n")
lock = DesktopInputLock(path, owner={"id": name, "name": name}, room="7", tool="desktop_act", wait=wait)
try:
    lock.acquire()
except DesktopBusy as exc:
    write("busy", error=str(exc)); sys.exit(3)
write("enter")
if mode == "crash":
    os._exit(9)
time.sleep(hold)
write("exit")
lock.release()
"""


def spawn(path, log, name, hold, wait=30, mode="ok"):
    return subprocess.Popen([sys.executable, "-c", CHILD, str(HERE), str(path), str(log), name,
                             str(hold), str(wait), mode])


def events(log):
    return [json.loads(line) for line in Path(log).read_text(encoding="utf-8").splitlines()]


def wait_for(predicate, timeout=10):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class DesktopInputLockTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "lock.sqlite"
        self.log = Path(self.dir.name) / "log.jsonl"
        self.log.touch()

    def tearDown(self):
        self.dir.cleanup()

    def entered(self, name):
        return lambda: any(e["event"] == "enter" and e["name"] == name for e in events(self.log))

    def test_mutual_exclusion_and_fifo_across_processes(self):
        first = spawn(self.path, self.log, "A", 0.8)
        self.assertTrue(wait_for(self.entered("A")))
        waiters = []
        for name in "BCD":
            waiters.append(spawn(self.path, self.log, name, 0.15))
            time.sleep(0.2)  # enqueue in a known order while A still holds
        for p in [first, *waiters]:
            self.assertEqual(p.wait(30), 0)
        log = events(self.log)
        self.assertEqual([e["name"] for e in log if e["event"] == "enter"], list("ABCD"))
        # Never two holders: each enter follows the previous exit.
        seq = [(e["event"], e["name"]) for e in log]
        self.assertEqual(seq, [(ev, n) for n in "ABCD" for ev in ("enter", "exit")])

    def test_timeout_names_the_holder(self):
        holder = spawn(self.path, self.log, "Room-A-agent", 4)
        self.assertTrue(wait_for(self.entered("Room-A-agent")))
        start = time.monotonic()
        with self.assertRaises(L.DesktopBusy) as ctx:
            L.DesktopInputLock(self.path, owner={"id": "b", "name": "B"}, room="2", tool="desktop_click", wait=0.6).acquire()
        self.assertGreaterEqual(time.monotonic() - start, 0.55)
        message = str(ctx.exception)
        self.assertIn("Room-A-agent", message)
        self.assertIn("room 7", message)
        self.assertIn("desktop_act", message)
        self.assertIn("détient", message)
        # The timed-out caller left the queue.
        db = sqlite3.connect(self.path)
        rows = db.execute("SELECT name FROM queue").fetchall()
        db.close()
        self.assertEqual(rows, [("Room-A-agent",)])
        holder.wait(30)

    def test_crashed_holder_is_released(self):
        crashed = spawn(self.path, self.log, "crasher", 0, mode="crash")
        self.assertEqual(crashed.wait(30), 9)
        start = time.monotonic()
        with L.DesktopInputLock(self.path, owner={"id": "n", "name": "N"}, tool="desktop_act", wait=5):
            pass
        self.assertLess(time.monotonic() - start, 2)  # dead pid: no need to wait for staleness

    def test_frozen_holder_released_after_stale_timeout(self):
        db = L._connect(self.path)
        old = time.time() - L.STALE_SECONDS - 1
        db.execute("INSERT INTO queue (pid,owner,name,room,tool,enqueued,heartbeat,acquired) VALUES (?,?,?,?,?,?,?,?)",
                   (os.getpid() + 1_000_000, "x", "frozen", "3", "desktop_act", old, old, old))
        db.close()
        with L.DesktopInputLock(self.path, owner={"id": "n"}, wait=2, alive=lambda pid: True) as lock:
            self.assertIsNotNone(lock.ticket)

    def test_live_holder_heartbeat_keeps_lock_beyond_stale_timeout(self):
        orig = L.STALE_SECONDS
        L.STALE_SECONDS = 1.5
        try:
            holder = L.DesktopInputLock(self.path, owner={"id": "a", "name": "A"}, tool="desktop_page").acquire()
            try:
                with self.assertRaises(L.DesktopBusy):
                    L.DesktopInputLock(self.path, owner={"id": "b"}, wait=3).acquire()
            finally:
                holder.release()
            with L.DesktopInputLock(self.path, owner={"id": "b"}, wait=1):
                pass
        finally:
            L.STALE_SECONDS = orig

    def test_release_is_idempotent_and_queue_empty(self):
        lock = L.DesktopInputLock(self.path, owner={"id": "a"}).acquire()
        lock.release()
        lock.release()
        db = sqlite3.connect(self.path)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM queue").fetchone()[0], 0)
        db.close()


if __name__ == "__main__":
    unittest.main()
