"""Session-local baselines for successive MCP Unicode screen reads."""
import json
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path


def archive_grid(req, grid, columns, window):
    from desktop_vision import save_grid
    try:
        save_grid(req, grid, columns, window)
    except (sqlite3.Error, OSError) as exc:
        print(f"Vision: {exc}", file=sys.stderr)


def changed_cells(before, after):
    changes = []
    old_rows, new_rows = before.split("\n"), after.split("\n")
    for index in range(max(len(old_rows), len(new_rows))):
        old = old_rows[index] if index < len(old_rows) else ""
        new = new_rows[index] if index < len(new_rows) else ""
        if old == new:
            continue
        width = max(len(old), len(new))
        old, new = old.ljust(width), new.ljust(width)
        dirty = [a != b for a, b in zip(old, new)]
        # Return a complete copyable target when any cell in its token changed.
        for match in re.finditer(r"\[[^\[\]]+\]", new):
            left, right = match.span()
            if any(dirty[left:right]):
                dirty[left:right] = [True] * (right-left)
        column = 0
        while column < width:
            if not dirty[column]:
                column += 1
                continue
            end = column + 1
            while end < width and dirty[end]:
                end += 1
            value = new[column:end]
            change = {"row": index + 1, "column": column + 1}
            if value.strip(" "):
                change["text"] = value
            else:
                change["clear"] = len(value)
            changes.append(change)
            column = end
    return changes


def capture_response(req, capture, desktop_identity):
    args = req["args"]
    reading = req["tool"] in ("desktop_ascii", "desktop_observe") and args.get("mode", "ascii") == "ascii"
    navigation = req["tool"] in ("desktop_click_excerpt", "desktop_scrollto")
    if not (reading or navigation) or not req.get("cache"):
        result = capture(req)
        for entry in result if isinstance(result, list) else [result]:
            if isinstance(entry, dict) and isinstance(entry.get("grid_text"), str):
                archive_grid(req, entry["grid_text"], entry["columns"], entry.get("window"))
        return result
    # One private cache per MCP registration. Taking the write lock before
    # the actual observation orders concurrent reads, and a failed observation
    # rolls back without advancing its baseline.
    database = Path(req["cache"]) / "ascii-baselines.sqlite"
    with closing(sqlite3.connect(database, timeout=95)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS baselines (target TEXT PRIMARY KEY, grid TEXT NOT NULL)")
        result = capture(req)
        if navigation:
            if (not result.get("capture") or result.get("feedback", "ascii") != "ascii"):
                return result
            # Click feedback only transports its changed rectangle. Its stored
            # full capture (also used for the next click) is the real baseline.
            manifest = Path(req["cache"]) / result["capture"] / "ascii.json"
            frame = json.loads(manifest.read_text(encoding="utf-8"))
            grid = "\n".join(line.rstrip(" ") for line in frame["grid"])
            window, columns, simplified = str(frame["hwnd"]), frame["columns"], frame["simplified"]
        else:
            grid = result["grid_text"]
            window, columns, simplified = result.get("window"), result["columns"], args.get("simplified", True)
        target = json.dumps([str(desktop_identity()), window, args.get("region"),
                             columns, simplified], sort_keys=True)
        row = db.execute("SELECT grid FROM baselines WHERE target=?", (target,)).fetchone()
        db.execute("INSERT OR REPLACE INTO baselines(target,grid) VALUES (?,?)", (target, grid))
        archive_grid(req, grid, columns, window)
        if navigation:
            return result
        if row is None or not args.get("diff", True):
            result["diff"] = False
        else:
            result.pop("grid_text")
            result["diff"] = True
            result["changes"] = changed_cells(row[0], grid)
            result["changed"] = bool(result["changes"])
        return result
