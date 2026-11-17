"""Windows desktop worker. Receives one validated JSON request on stdin."""

import base64
import csv
import ctypes
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sqlite3
import tempfile
import time
import uuid

ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
import pyautogui as mouse
import win32api
import win32con
import win32event
import win32gui as gui
import win32process
import win32ts
from PIL import Image, ImageChops, ImageDraw, ImageGrab


# One request per worker process. Set by dispatch from the trusted MCP configuration.
call_vision_sessions = set()
room_desktop = None
room_number = None
browser_root = None
# The room's own virtual desktop, kept when a request targets another one (desktop=N).
own_desktop = None
# 1-based Windows virtual desktop chosen by the caller, or None for the room's desktop.
target_desktop = None


def belongs_to_room(hwnd):
    if room_desktop is None:
        return True
    from room_desktop import owns
    return owns(room_desktop, hwnd)


def windows():
    result = []

    def collect(hwnd, _):
        title = gui.GetWindowText(hwnd)
        if gui.GetClassName(hwnd) in ("Shell_TrayWnd", "Shell_SecondaryTrayWnd"):
            result.append(
                dict(
                    id=str(hwnd),
                    title="Barre des tâches",
                    role="taskbar",
                    active=hwnd == gui.GetForegroundWindow(),
                )
            )
            return
        if (
            title
            and gui.IsWindowVisible(hwnd)
            and belongs_to_room(hwnd)
            and gui.GetClassName(hwnd) not in ("Progman", "WorkerW")
        ):
            result.append(
                dict(
                    id=str(hwnd), title=title, active=hwnd == gui.GetForegroundWindow()
                )
            )

    gui.EnumWindows(collect, None)
    return result


def plain_windows():
    """Visible titled top-level windows on every virtual desktop (no room filter)."""
    found = []

    def collect(hwnd, _):
        title = gui.GetWindowText(hwnd)
        if (title and gui.IsWindowVisible(hwnd)
                and gui.GetClassName(hwnd) not in ("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd")):
            found.append((hwnd, title))

    gui.EnumWindows(collect, None)
    return found


def match(items, name):
    exact = [
        item
        for item in items
        if name == item.get("id") or name.casefold() == item["title"].casefold()
    ]
    hits = exact or [
        item for item in items if name.casefold() in item["title"].casefold()
    ]
    if len(hits) != 1:
        raise ValueError(f"{name!r}: {len(hits)} correspondances: {hits[:10]}")
    return hits[0]


def focus(hwnd):
    if not belongs_to_room(hwnd):
        raise ValueError("Fenêtre extérieure au bureau ciblé (room par défaut, ou desktop=N).")
    if gui.IsIconic(hwnd):
        gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    if gui.GetForegroundWindow() != hwnd:
        foreground = gui.GetForegroundWindow()
        current = win32api.GetCurrentThreadId()
        threads = {
            win32process.GetWindowThreadProcessId(h)[0] for h in (foreground, hwnd) if h
        }
        attached = []
        try:
            for thread in threads - {current}:
                win32process.AttachThreadInput(current, thread, True)
                attached.append(thread)
            gui.BringWindowToTop(hwnd)
            gui.SetForegroundWindow(hwnd)
        finally:
            for thread in reversed(attached):
                win32process.AttachThreadInput(current, thread, False)
    time.sleep(0.18)
    check_focus(hwnd)


def check_focus(hwnd):
    if gui.GetForegroundWindow() != hwnd or not belongs_to_room(hwnd):
        raise ValueError("La fenêtre cible a perdu le focus.")


def window_ui(hwnd):
    from pywinauto import Desktop

    return Desktop(backend="uia").window(handle=hwnd).wrapper_object()


def tabs(hwnd):
    # Do not descend into web content: an HTML tab is not a browser tab.
    from pywinauto.uia_defines import IUIA

    api = IUIA().iuia
    from comtypes.gen import UIAutomationClient as UIA

    cond = api.CreatePropertyCondition(
        UIA.UIA_ControlTypePropertyId, UIA.UIA_TabItemControlTypeId
    )
    root = window_ui(hwnd)
    items = root.element_info.element.FindAll(UIA.TreeScope_Descendants, cond)
    walker = api.ControlViewWalker
    result = []
    for i in range(items.Length):
        el = items.GetElement(i)
        ancestor = walker.GetParentElement(el)
        while ancestor and not api.CompareElements(root.element_info.element, ancestor):
            if ancestor.CurrentControlType == UIA.UIA_DocumentControlTypeId:
                break
            ancestor = walker.GetParentElement(ancestor)
        else:
            result.append(
                (
                    dict(
                        id=".".join(map(str, el.GetRuntimeId())),
                        title=el.CurrentName or "",
                    ),
                    el,
                )
            )
    return result


def document_text(hwnd):
    """Whole web page text through UIA TextPattern: no focus, no scrolling, no input.

    Chrome only exposes web content to UI Automation when its renderer accessibility
    is on (--force-renderer-accessibility, chrome://accessibility, or an assistive
    technology). Returns None when no document with TextPattern is exposed.
    """
    from pywinauto.uia_defines import IUIA
    from comtypes.gen import UIAutomationClient as UIA

    api = IUIA().iuia
    root = api.ElementFromHandle(hwnd)
    cond = api.CreatePropertyCondition(UIA.UIA_ControlTypePropertyId, UIA.UIA_DocumentControlTypeId)
    docs = root.FindAll(UIA.TreeScope_Descendants, cond)
    for i in range(docs.Length):
        doc = docs.GetElement(i)
        if doc.CurrentIsOffscreen:
            continue
        try:
            pattern = doc.GetCurrentPattern(UIA.UIA_TextPatternId)
            if not pattern:
                continue
            text = pattern.QueryInterface(UIA.IUIAutomationTextPattern).DocumentRange.GetText(-1)
        except Exception:
            continue
        if text and text.strip():
            return text
    return None


# Below this many words, UIA only exposed the browser frame (Chrome without web
# accessibility); the page is then read by scrolling and OCR instead.
MIN_UIA_WORDS = 15


def uia_page_text(hwnd):
    """Page text from UIA when it is significant, otherwise None (use OCR slices)."""
    try:
        text = document_text(hwnd)
    except Exception:
        return None
    if not text:
        return None
    import re
    words = re.findall(r"\w{2,}", text.replace("￼", " "))
    return text if len(words) >= MIN_UIA_WORDS else None


def render_widget(hwnd):
    """Chrome/Edge web content child window, used when UIA exposes no Document."""
    found = []

    def collect(child, _):
        if gui.GetClassName(child) == "Chrome_RenderWidgetHostHWND" and gui.IsWindowVisible(child):
            found.append(child)
    try:
        gui.EnumChildWindows(hwnd, collect, None)
    except Exception:
        pass
    if not found:
        return None
    return max(found, key=lambda h: (lambda r: (r[2] - r[0]) * (r[3] - r[1]))(gui.GetWindowRect(h)))


WHEEL_DELTA = 120


def page_wheel(hwnd, point, delta):
    """Wheel over the target window's own web content only, never another window."""
    check_focus(hwnd)
    hit = gui.WindowFromPoint(point)
    if not hit or gui.GetAncestor(hit, win32con.GA_ROOT) != hwnd:
        raise ValueError("La page est recouverte par une autre fenêtre : défilement annulé.")
    mouse.scroll(delta, *point)


def stitch(pages):
    """Join per-slice text lines, dropping the lines repeated by viewport overlap."""
    merged = []
    for lines in pages:
        best = 0
        for size in range(min(len(merged), len(lines)), 0, -1):
            if merged[-size:] == lines[:size]:
                best = size
                break
        merged.extend(lines[best:])
    return "\n".join(merged)


def ocr_lines(image):
    lines = {}
    for word in ocr(image, 0, 0, with_lines=True):
        lines.setdefault(word["line"], []).append(word["text"])
    return [" ".join(words) for _, words in sorted(lines.items(), key=lambda kv: tuple(int(v) for v in kv[0]))]


def bounds(hwnd=None):
    if hwnd is None:
        x, y, w, h = [win32api.GetSystemMetrics(i) for i in (76, 77, 78, 79)]
        return x, y, x + w, y + h
    x, y, r, b = gui.GetWindowRect(hwnd)
    l, t, rr, bb = bounds()
    return max(l, x), max(t, y), min(r, rr), min(b, bb)


def current_desktop_id():
    from room_desktop import VirtualDesktop
    return str(VirtualDesktop.current().id)


def check_room_view(expected=None):
    if expected is None and room_desktop is not None:
        expected = str(room_desktop.id)
    if expected is not None and current_desktop_id() != expected:
        raise ValueError("Le bureau actif ne correspond plus à la capture. Refaites une observation.")


def capture(box, expected=None):
    check_room_view(expected)
    image = ImageGrab.grab(bbox=box, all_screens=True).convert("RGB")
    check_room_view(expected)
    return image


def window_id(value):
    """Window handle when value is a numeric ID of an existing window, else None."""
    if isinstance(value, str) and value.isdigit():
        hwnd = int(value)
        if gui.IsWindow(hwnd):
            return hwnd
    return None


def desktop_windows_bottom_up(desktop):
    """Visible top-level windows of a virtual desktop, from the bottom of the z-order."""
    from room_desktop import owns
    found = []

    def collect(hwnd, _):
        if (gui.IsWindowVisible(hwnd) and not gui.IsIconic(hwnd)
                and gui.GetClassName(hwnd) not in ("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd")
                and owns(desktop, hwnd)):
            found.append(hwnd)
    gui.EnumWindows(collect, None)  # top of the z-order first
    return found[::-1]


def composite_desktop(box):
    """Screen of a non-visible virtual desktop, painted from PrintWindow of its windows.

    No desktop switch, focus change, scroll or overlay: the human's screen stays still.
    """
    canvas = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), (32, 32, 32))
    for hwnd in desktop_windows_bottom_up(room_desktop):
        try:
            left, top, right, bottom = gui.GetWindowRect(hwnd)
            if right <= box[0] or bottom <= box[1] or left >= box[2] or top >= box[3]:
                continue
            image = read_window(hwnd, (left, top, right, bottom))
        except Exception:
            continue  # a window refusing PrintWindow leaves its area as background
        canvas.paste(image, (left - box[0], top - box[1]))
    return canvas


def read_window(hwnd, box):
    if hwnd is None and room_desktop is not None and current_desktop_id() != str(room_desktop.id):
        return composite_desktop(box)
    if hwnd is None or (room_desktop is None and gui.GetForegroundWindow() == hwnd):
        return capture(box)
    left, top, right, bottom = gui.GetWindowRect(hwnd)
    if gui.IsIconic(hwnd) or right <= left or bottom <= top:
        raise ValueError("Cette fenêtre ne fournit pas de capture en arrière-plan.")
    dc = gui.GetWindowDC(hwnd)
    dest = bitmap = None
    try:
        size = (right - left, bottom - top)
        dest = gui.CreateCompatibleDC(dc)
        bitmap = gui.CreateCompatibleBitmap(dc, *size)
        old = gui.SelectObject(dest, bitmap)
        try:
            if not ctypes.windll.user32.PrintWindow(ctypes.c_void_p(hwnd), ctypes.c_void_p(int(dest)), 2):
                raise ValueError("La fenêtre a refusé la capture en arrière-plan.")
            data = ctypes.create_string_buffer(size[0] * size[1] * 4)
            if ctypes.windll.gdi32.GetBitmapBits(ctypes.c_void_p(int(bitmap)), len(data), data) != len(data):
                raise ValueError("Capture Windows incomplète.")
        finally:
            gui.SelectObject(dest, old)
        image = Image.frombytes("RGB", size, data.raw, "raw", "BGRX")
        x, y, r, b = box
        return image.crop((x-left, y-top, r-left, b-top))
    finally:
        if bitmap:
            gui.DeleteObject(bitmap)
        if dest:
            gui.DeleteDC(dest)
        gui.ReleaseDC(hwnd, dc)


def tesseract_path():
    """Locate tesseract.exe without assuming a full environment.

    MCP servers may be spawned with a reduced environment (no ProgramFiles,
    sometimes a short PATH), so env lookups are optional and fixed paths
    are tried last.
    """
    found = shutil.which("tesseract")
    if found:
        return found
    env = os.environ.get
    bases = [env("TESSERACT_HOME"), env("ProgramFiles"), env("ProgramW6432"),
             env("ProgramFiles(x86)"), r"C:\Program Files", r"C:\Program Files (x86)"]
    local = env("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    bases.append(os.path.join(local, "Programs"))
    candidates = []
    for base in bases:
        if not base:
            continue
        candidates.append(os.path.join(base, "tesseract.exe"))
        candidates.append(os.path.join(base, "Tesseract-OCR", "tesseract.exe"))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(
        "Tesseract OCR introuvable (PATH, ProgramFiles, C:\\Program Files\\Tesseract-OCR)."
    )


def ocr(image, x, y, *, with_lines=False):
    engine = tesseract_path()
    buf = io.BytesIO()
    image.save(buf, "PNG")
    data = subprocess.run(
        [engine, "stdin", "stdout", "--psm", "11", "tsv"],
        input=buf.getvalue(),
        capture_output=True,
        timeout=20,
        check=True,
    )
    words = []
    for row in csv.DictReader(
        io.StringIO(data.stdout.decode("utf-8")), delimiter="\t", quoting=csv.QUOTE_NONE
    ):
        if row["text"].strip():
            words.append(
                dict(
                    text=row["text"],
                    x=x + int(row["left"]),
                    y=y + int(row["top"]),
                    width=int(row["width"]),
                    height=int(row["height"]),
                )
            )
            if with_lines:
                words[-1]["line"] = (row["block_num"], row["par_num"], row["line_num"])
    return words


def compact_grid(grid):
    # Keep every row and leading column: copied excerpts retain their coordinates.
    # Only discard right padding in the transport; cached grids stay rectangular.
    return "\n".join(line.rstrip(" ") for line in grid)


def render(im, x, y, args, frame_cache=None, frame_key=None):
    info = dict(x=x, y=y, width=im.width, height=im.height)
    mode = args.get("mode", "ascii")
    if mode == "ascii":
        grid, _, _ = snapshot_grid(args, im, frame_cache=frame_cache, frame_key=frame_key)
        info.update(columns=args.get("columns", 160), rows=len(grid), grid_text=compact_grid(grid))
    if call_vision_sessions and mode in ("ascii", "ocr"):
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=72)
        info["_vision_jpeg"] = base64.b64encode(buf.getvalue()).decode("ascii")
    if mode in ("ocr", "both"):
        info["words"] = ocr(im, x, y)
    if mode in ("image", "both"):
        step = args.get("grid", 0)
        if step:
            draw = ImageDraw.Draw(im)
            for i in range((-x) % step, im.width, step):
                draw.line((i, 0, i, im.height), fill="cyan")
                draw.text(
                    (i + 2, 2),
                    str(i + x),
                    fill="white",
                    stroke_width=1,
                    stroke_fill="black",
                )
            for j in range((-y) % step, im.height, step):
                draw.line((0, j, im.width, j), fill="cyan")
                draw.text(
                    (2, j + 2),
                    str(j + y),
                    fill="white",
                    stroke_width=1,
                    stroke_fill="black",
                )
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=72)
        info["jpeg"] = base64.b64encode(buf.getvalue()).decode("ascii")
    return info


def move_pointer(x, y):
    start_x, start_y = mouse.position()
    dx, dy = x - start_x, y - start_y
    distance = math.hypot(dx, dy)
    if not distance:
        return
    duration = min(0.30, 0.045 + distance / 4500)
    steps = max(2, round(duration * 75))
    start = time.monotonic()
    for index in range(1, steps + 1):
        t = index / steps
        progress = t * t * (3 - 2 * t)
        # Let the shorter axis follow slightly later on a diagonal.
        lag = 0.12 * progress * (1 - progress)
        px = progress - lag if abs(dx) < abs(dy) else progress
        py = progress - lag if abs(dy) <= abs(dx) else progress
        time.sleep(max(0, start + duration * t - time.monotonic()))
        mouse.moveTo(round(start_x + dx * px), round(start_y + dy * py), _pause=False)


def type_text(text, hwnd):
    # Send literal UTF-16 code units independently of the active keyboard layout.
    from ctypes import wintypes

    class Keyboard(ctypes.Structure):
        _fields_ = [
            ("vk", wintypes.WORD),
            ("scan", wintypes.WORD),
            ("flags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("extra", ctypes.c_size_t),
        ]

    class Mouse(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("data", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("extra", ctypes.c_size_t),
        ]

    class Payload(ctypes.Union):
        _fields_ = [("keyboard", Keyboard), ("mouse", Mouse)]

    class Input(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("payload", Payload)]

    # Bound the time spent animating a large insertion or a batch of insertions.
    chunk_size = max(1, math.ceil(len(text) / 64))
    for start in range(0, len(text), chunk_size):
        check_focus(hwnd)
        chunk = text[start : start + chunk_size]
        data = chunk.encode("utf-16-le")
        events = []
        for i in range(0, len(data), 2):
            unit = int.from_bytes(data[i : i + 2], "little")
            for flags in (4, 6):
                events.append(Input(1, Payload(keyboard=Keyboard(0, unit, flags, 0, 0))))
        sent = ctypes.windll.user32.SendInput(
            len(events), (Input * len(events))(*events), ctypes.sizeof(Input)
        )
        if sent != len(events):
            raise OSError("Saisie Unicode incomplète")
        if start + chunk_size < len(text):
            last = chunk[-1]
            delay = 0.024 if last.isspace() else 0.028 if not last.isalnum() else 0.018
            time.sleep(delay)


def locate_label(hwnd, label):
    expected = label.casefold().split()
    deadline = time.monotonic() + 2
    while True:
        box = bounds(hwnd)
        words = ocr(capture(box), *box[:2], with_lines=True)
        points = []
        for i in range(len(words) - len(expected) + 1):
            span = words[i:i + len(expected)]
            if [word["text"].casefold() for word in span] != expected:
                continue
            if any(word["line"] != span[0]["line"] for word in span):
                continue
            # Use a point on an actual word, even when the label has wide spacing.
            word = span[len(span) // 2]
            points.append((word["x"] + word["width"] // 2, word["y"] + word["height"] // 2))
        if len(points) == 1:
            return points[0]
        if points:
            raise ValueError(f"{label!r} apparaît plusieurs fois aux points {points}.")
        if time.monotonic() >= deadline:
            raise ValueError(f"Libellé introuvable : {label!r}")
        time.sleep(0.15)


def normalize_keys(keys, allowed):
    """Normalize named keys only; never evaluate or execute a shortcut expression."""
    aliases = {"control": "ctrl", "controlleft": "ctrlleft", "controlright": "ctrlright"}
    result = []
    for value in keys:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Touche inconnue : nom vide ou invalide")
        token = value.strip()
        parts = token.split("+") if "+" in token and len(token) > 1 else [token]
        for part in parts:
            key = aliases.get(part.strip().lower(), part.strip().lower())
            if not key or key not in allowed:
                raise ValueError(f"Touche inconnue : {part!r}")
            result.append(key)
    if not 1 <= len(result) <= 5:
        raise ValueError("Raccourci attendu : de 1 à 5 touches")
    return result


def act(hwnd, actions):
    # Reject a bad keyboard batch before focus, pointer gestures or text insertion.
    normalized = []
    for index, action in enumerate(actions):
        try:
            normalized.append({**action, "keys": normalize_keys(action["keys"], mouse.KEYBOARD_KEYS)}
                              if action["op"] == "keys" else action)
        except ValueError as exc:
            raise ValueError(f"0 actions terminées, action {index + 1}: {exc}") from exc
    actions = normalized
    reports = []
    taskbar = gui.GetClassName(hwnd) in ("Shell_TrayWnd", "Shell_SecondaryTrayWnd")
    if taskbar:
        if any(a["op"] not in ("click", "move") for a in actions):
            raise ValueError(
                "La barre des tâches accepte uniquement des gestes de pointeur."
            )
    else:
        focus(hwnd)
    for index, action in enumerate(actions):
        try:
            check_room_view()
            if not taskbar:
                check_focus(hwnd)
            op = action["op"]
            follow = action.get("auto_scroll")
            if follow:
                from desktop_scroll import follow_content, named_items
                before_items = set(named_items(hwnd)) if follow is True else set()
            if op in ("move", "click", "scroll"):
                if op == "click" and "label" in action:
                    x, y = locate_label(hwnd, action["label"])
                else:
                    x, y = action["x"], action["y"]
                hit = gui.WindowFromPoint((x, y))
                if not hit or gui.GetAncestor(hit, win32con.GA_ROOT) != hwnd:
                    raise ValueError(
                        "Le point est hors de la fenêtre cible ou recouvert."
                    )
                move_pointer(x, y)
                if op != "move":
                    check_room_view()
                    if not taskbar:
                        check_focus(hwnd)
                    hit = gui.WindowFromPoint((x, y))
                    if not hit or gui.GetAncestor(hit, win32con.GA_ROOT) != hwnd or mouse.position() != (x, y):
                        raise ValueError("La cible a changé pendant le déplacement.")
                if op == "click":
                    mouse.click(
                        button=action["button"], clicks=action["count"], interval=0.08
                    )
                if op == "scroll":
                    if "pixels" in action:
                        from desktop_scroll import scroll_pixels
                        reports.append(dict(action=index+1, **scroll_pixels(hwnd, x, y, action["pixels"])))
                    else:
                        mouse.scroll(action["ticks"])
            elif op == "keys":
                mouse.hotkey(*action["keys"], interval=0.015 + 0.003 * len(action["keys"]))
            elif op == "text":
                type_text(action["text"], hwnd)
            else:
                time.sleep(action["ms"] / 1000)
            if follow:
                try:
                    outcome = follow_content(hwnd, before_items, follow)
                except Exception as exc:
                    outcome = dict(status="unavailable", reason=str(exc))
                reports.append(dict(action=index+1, auto_scroll=outcome))
        except Exception as e:
            raise ValueError(
                f"{index} actions terminées, action {index + 1}: {e}"
            ) from e
    return dict(completed=len(actions), **({"scroll": reports} if reports else {}))


def snapshot_grid(a, image, hwnd=None, box=None, frame_cache=None, frame_key=None):
    from capture_unicode_core import recognize_labels, render_image
    from desktop_clickables import annotate, window_targets

    simplified = a.get("simplified", True)
    columns = a.get("columns", 160)
    targets = window_targets(hwnd, box) if simplified and hwnd and box else []
    def render_labels(labels):
        spans, visual_targets = [], []
        grid = render_image(image, columns, simplified=simplified, spans=spans,
                            visual_targets=visual_targets, labels=labels).split("\n")
        if simplified:
            return annotate(grid, spans, image, targets or visual_targets)
        return grid, spans, []
    if frame_cache is None:
        return render_labels(None)
    from desktop_frame_cache import cached_frame
    key = [str(room_desktop.id) if room_desktop else None, frame_key, columns, simplified]
    return cached_frame(frame_cache, key, image, targets, lambda im: recognize_labels(im, simplified),
                        render_labels, a.get("diff", True))


def store_snapshot(hwnd, a, cache, box, image, rendered=None, cache_read=False):
    pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    grid, spans, controls = rendered if rendered is not None else snapshot_grid(
        a, image, hwnd, box, cache if cache_read else None, ("window", hwnd, pid, box))
    ident = str(uuid.uuid4())
    folder = cache / ident
    folder.mkdir()
    image.save(folder / "screen.png")
    info = dict(hwnd=hwnd, pid=pid, desktop_id=str(room_desktop.id) if room_desktop else current_desktop_id(),
                box=box, grid=grid, spans=spans, controls=controls, columns=a["columns"],
                simplified=a["simplified"], feedback=a.get("feedback", "ascii"))
    (folder / "ascii.json").write_text(json.dumps(info), encoding="utf8")
    return ident, info


def feedback_frame(desktop):
    from room_desktop import switch

    # Keep the selected desktop visible while the click's UI paints. A switch
    # during this interval starts a fresh interval on the target desktop.
    stable_since = time.monotonic()
    deadline = stable_since + 10
    while True:
        if time.monotonic() >= deadline:
            raise RuntimeError("Windows n’a pas fourni d’image stable du bureau après le clic.")
        if current_desktop_id() != str(desktop.id):
            switch(desktop)
            stable_since = time.monotonic()
        remaining = (stable_since + 2.0) - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.1, remaining))
            continue
        hwnd = gui.GetForegroundWindow()
        if not hwnd:
            time.sleep(0.1)
            continue
        box = bounds(hwnd)
        image = ImageGrab.grab(bbox=box, all_screens=True).convert("RGB")
        if current_desktop_id() == str(desktop.id) and gui.GetForegroundWindow() == hwnd:
            return hwnd, box, image
        stable_since = time.monotonic()


def click_feedback(before, snapshot, cache, desktop, restore_view):
    hwnd, box, after = feedback_frame(desktop)
    if restore_view:
        restore_view()
    switched = hwnd != snapshot["hwnd"] or tuple(snapshot["box"]) != box
    rect = (0, 0, *after.size) if switched else ImageChops.difference(before, after).getbbox()
    ident, info = store_snapshot(hwnd, snapshot, cache, box, after, cache_read=True)
    result = dict(capture=ident, window=str(hwnd), desktop_id=snapshot["desktop_id"],
                  changed=bool(rect), feedback=info["feedback"])
    if not rect:
        return result
    left, top, right, bottom = rect
    result["region"] = dict(x=box[0]+left, y=box[1]+top, width=right-left, height=bottom-top)
    if info["feedback"] == "image":
        result["jpeg"] = render(after.crop(rect), 0, 0, {"mode":"image"})["jpeg"]
        return result
    cols, rows = info["columns"], len(info["grid"])
    l, t = left*cols//after.width, top*rows//after.height
    r = (right*cols+after.width-1)//after.width
    b = (bottom*rows+after.height-1)//after.height
    # OCR placement may shift a word horizontally or compress its height.
    # Include complete words intersecting the changed pixels in either frame.
    for mapping in ([info] if switched else [snapshot, info]):
        for row, start, end, x, y, rr, bb in mapping["spans"]:
            if x < right and rr > left and y < bottom and bb > top:
                l, r = min(l, start), max(r, end)
                t, b = min(t, row), max(b, row+1)
    result.update(row=t+1, column=l+1, grid_text=compact_grid(line[l:r] for line in info["grid"][t:b]))
    return result


def excerpt_matches(grid, a, controls=()):
    lines = a["excerpt"].replace("\r\n", "\n").strip("\n").split("\n")
    points = [(r, c) for r, line in enumerate(lines) for c, char in enumerate(line) if not char.isspace()]
    if not points:
        raise ValueError("Copiez au moins un caractère visible.")
    matches = []
    for row in range(len(grid) - len(lines) + 1):
        if "row" in a and row + 1 != a["row"]:
            continue
        offset = 0
        while offset <= len(grid[row]):
            col = grid[row].find(lines[0], offset)
            if col < 0:
                break
            offset = col + 1
            if "column" in a and col + 1 != a["column"]:
                continue
            if all(grid[row + i].startswith(line, col) for i, line in enumerate(lines)):
                matches.append((row, col))
    if len(lines) == 1 and lines[0].startswith("[") and lines[0].endswith("]"):
        marked = {(r, c) for r,c,end,*_ in controls if end-c == len(lines[0])}
        matches = [point for point in matches if point in marked] or matches
    return matches, lines, points


def scrollto(hwnd, a, cache):
    import re
    from desktop_scroll import scroll_container, Desktop

    focus(hwnd)
    box = bounds(hwnd)
    panel = a.get("panel") or dict(x=(box[0]+box[2])//2, y=(box[1]+box[3])//2)
    x, y = panel["x"], panel["y"]
    target = a["target"]
    if "text" in target:
        pattern = re.compile(r"\s+".join(re.escape(word) for word in target["text"].split()), re.IGNORECASE)
    container = None
    for step in range(a["max_steps"]+1):
        check_focus(hwnd)
        if bounds(hwnd) != box:
            raise ValueError("La fenêtre a bougé pendant la recherche.")
        image = capture(box)
        grid, spans, controls = snapshot_grid(a, image, hwnd, box)
        candidates = []
        if "ascii" in target:
            matches, lines, _ = excerpt_matches(grid, {"excerpt": target["ascii"]}, controls)
            candidates = [dict(row=r+1, column=c+1, excerpt="\n".join(lines)) for r,c in matches[:32]]
        else:
            for r, line in enumerate(grid):
                for match in pattern.finditer(line):
                    candidates.append(dict(row=r+1, column=match.start()+1, excerpt=match.group()))
                    if len(candidates) == 32:
                        break
                if len(candidates) == 32:
                    break
        if candidates:
            status = "found"
            break
        if step == a["max_steps"]:
            status = "limit"
            break
        hit = gui.WindowFromPoint((x, y))
        if not hit or gui.GetAncestor(hit, win32con.GA_ROOT) != hwnd:
            raise ValueError("Le point du panneau est hors de la fenêtre ou recouvert.")
        if container is None:
            container = scroll_container(hwnd, Desktop(backend="uia").from_point(x, y))
        delta = max(1, int(container.rectangle().height() * .65))
        movement = scroll_container(hwnd, container, delta if a["direction"] == "down" else -delta)
        if not movement["moved"]:
            status = "no_movement"
            break
        time.sleep(.15)
    ident, _ = store_snapshot(hwnd, a, cache, box, image, (grid, spans, controls))
    return dict(status=status, capture=ident, window=str(hwnd), steps=step,
                candidates=candidates, grid_text=compact_grid(grid))


def click_excerpt(folder, a, restore_view=None):
    manifest = folder / "ascii.json"
    if not manifest.is_file():
        raise ValueError("Capture ASCII absente de cette session.")
    snapshot = json.loads(manifest.read_text(encoding="utf8"))
    grid = snapshot["grid"]
    matches, lines, points = excerpt_matches(grid, a, snapshot.get("controls", []))
    if len(matches) != 1:
        return dict(clicked=False, matches=len(matches),
                    candidates=[dict(row=r+1, column=c+1) for r,c in matches[:32]])
    row, col = matches[0]
    max_width = max(map(len, lines))
    dr, dc = min(points, key=lambda p: (2*p[0]-len(lines)+1)**2 * 4
                 + (2*p[1]-max_width+1)**2)
    row, col = row + dr, col + dc
    x, y, right, bottom = snapshot["box"]
    w, h = right - x, bottom - y
    cols, rows = snapshot["columns"], len(grid)
    px, py = min(w-1, int((col+.5)*w/cols)), min(h-1, int((row+.5)*h/rows))
    target = (max(0,px-12), max(0,py-12), min(w,px+13), min(h,py+13))
    for r, start, end, l, t, rr, bb in snapshot["spans"]:
        if r == row and start <= col < end:
            target = (l, t, rr, bb)
            px, py = (l+rr)//2, (t+bb)//2
            break
    hwnd = snapshot["hwnd"]
    from room_desktop import VirtualDesktop, switch
    desktop = room_desktop or VirtualDesktop.current()
    switch(desktop)
    snapshot["desktop_id"] = str(desktop.id)
    check_focus(hwnd)
    if tuple(snapshot["box"]) != bounds(hwnd) or snapshot["pid"] != win32process.GetWindowThreadProcessId(hwnd)[1]:
        raise ValueError("Fenêtre modifiée. Refaites la capture.")
    before = capture(bounds(hwnd))
    with Image.open(folder / "screen.png") as saved:
        if before.crop(target).tobytes() != saved.crop(target).tobytes():
            raise ValueError("La cible a changé depuis la capture. Refaites la capture.")
    acted = act(hwnd, [dict(op="click", x=x+px, y=y+py, button="left", count=1, auto_scroll=a.get("auto_scroll"))])
    result = dict(clicked=True, x=x+px, y=y+py)
    if "scroll" in acted:
        result["auto_scroll"] = acted["scroll"][0]["auto_scroll"]
    snapshot["feedback"] = a.get("feedback", snapshot.get("feedback", "ascii"))
    try:
        result.update(click_feedback(before, snapshot, folder.parent, desktop, restore_view))
    except Exception as exc:
        result["observation_error"] = str(exc)
    return result


def run(tool, a, cache, restore_view=None):
    if tool == "desktop_list":
        from room_desktop import inventory
        return inventory(own_desktop, plain_windows)
    if tool == "desktop_open_url":
        if room_desktop is None:
            raise ValueError("A room-scoped MCP connection is required to open a page.")
        from desktop_browser import validate_url, profile_path, chrome_executable
        url = validate_url(a["url"])
        before = {item["id"] for item in windows()}
        if target_desktop is not None:
            # Explicit virtual desktop: the human's usual Chrome profile, new window on that desktop.
            command = [str(chrome_executable()), "--new-window", url]
        else:
            profile = profile_path(browser_root, room_number)
            profile.mkdir(parents=True, exist_ok=True)
            # Renderer accessibility lets desktop_page text=true read the page through UIA.
            command = [str(chrome_executable()), f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                       "--force-renderer-accessibility", "--new-window", url]
        child = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            check_room_view()
            created = [item for item in windows() if item["id"] not in before and gui.GetClassName(int(item["id"])).startswith("Chrome_WidgetWin")]
            if created:
                item = created[0]
                focus(int(item["id"]))
                return dict(room=room_number, desktop=str(room_desktop.id), desktop_number=room_desktop.number,
                            window=item["id"], title=gui.GetWindowText(int(item["id"])), navigation="requested",
                            launcher_pid=child.pid, isolated_profile=target_desktop is None)
            time.sleep(.1)
        raise ValueError("No new Chrome window owned by this room was observed. Existing windows were not moved.")
    if tool == "desktop_click_excerpt":
        return click_excerpt(cache / a["capture"], a, restore_view)
    if tool == "desktop_windows":
        return windows()
    if tool == "desktop_slice":
        folder = cache / a["capture"]
        manifest = json.loads((folder / "page.json").read_text())
        idx = a["slice"] - 1
        if idx >= len(manifest):
            raise ValueError("Numéro de tranche hors capture")
        with Image.open(folder / f"{idx + 1}.jpg") as im:
            offset = manifest[idx]
            return dict(page_y=offset, **render(im.convert("RGB"), 0, offset or 0, a))
    hwnd = int(match(windows(), a["window"])["id"]) if a.get("window") else None
    if tool == "desktop_scrollto":
        return scrollto(hwnd, a, cache)
    if tool == "desktop_ascii":
        if hwnd is None:
            hwnd = gui.GetForegroundWindow()
            if not hwnd or not belongs_to_room(hwnd):
                return run("desktop_observe", a, cache)
        elif not belongs_to_room(hwnd):
            raise ValueError("La fenêtre demandée n’appartient plus à ce bureau.")
        box = bounds(hwnd)
        ident, info = store_snapshot(hwnd, a, cache, box, read_window(hwnd, box), cache_read=True)
        return dict(capture=ident, window=str(hwnd), columns=info["columns"], rows=len(info["grid"]),
                    feedback=info["feedback"], grid_text=compact_grid(info["grid"]))
    if tool == "desktop_taskbar":
        bars = [w for w in windows() if w.get("role") == "taskbar"]
        items = []
        for bar in bars:
            for button in window_ui(int(bar["id"])).descendants(control_type="Button"):
                rect = button.rectangle()
                if rect.width() and rect.height() and button.window_text():
                    items.append(
                        dict(
                            window=bar["id"],
                            title=button.window_text(),
                            x=(rect.left + rect.right) // 2,
                            y=(rect.top + rect.bottom) // 2,
                        )
                    )
        return items
    if tool == "desktop_tabs":
        return [item for item, _ in tabs(hwnd)]
    if tool == "desktop_open":
        focus(hwnd)
        if a.get("tab"):
            choices = tabs(hwnd)
            from comtypes.gen import UIAutomationClient as UIA

            item = match([c for c, _ in choices], a["tab"])
            el = next(el for c, el in choices if item == c)
            sel = el.GetCurrentPattern(UIA.UIA_SelectionItemPatternId).QueryInterface(
                UIA.IUIAutomationSelectionItemPattern
            )
            sel.Select()
            if not sel.CurrentIsSelected:
                raise ValueError("Onglet non sélectionné")
        return dict(window=str(hwnd), title=gui.GetWindowText(hwnd))
    if tool == "desktop_click":
        clicks = []
        for target in a["targets"]:
            location = {"label": target} if isinstance(target, str) else target
            clicks.append(dict(op="click", button="left", count=1, auto_scroll=a.get("auto_scroll"), **location))
        return act(hwnd, clicks)
    if tool == "desktop_act":
        return act(hwnd, a["actions"])
    if tool == "desktop_sweep":
        results = []
        targets = a.get("windows") or [w["id"] for w in windows() if w.get("role") != "taskbar"]
        for target in targets:
            try:
                h = int(match(windows(), target)["id"])
                box = bounds(h)
                results.append(dict(window=str(h), title=gui.GetWindowText(h),
                                    **render(read_window(h, box), *box[:2], a)))
            except Exception as e:
                results.append(dict(window=target, error=str(e)))
        return results
    if tool == "desktop_page" and a.get("text"):
        # Empty or insignificant UIA text falls through to scrolling + OCR stitching.
        text = uia_page_text(hwnd)
        if text is not None:
            return dict(window=str(hwnd), title=gui.GetWindowText(hwnd), source="uia_text_pattern",
                        length=len(text), text=text)
    if tool == "desktop_page":
        focus(hwnd)
    box = bounds(hwnd)
    if tool == "desktop_page":
        root = window_ui(hwnd)
        try:
            docs = [d for d in root.descendants(control_type="Document") if d.is_visible()]
        except Exception:
            docs = []
        wheel = None
        if docs:
            rect = docs[0].rectangle()
            rect = rect.left, rect.top, rect.right, rect.bottom
        else:
            # Chrome without web accessibility exposes no Document: read its web
            # content child window and scroll it with the wheel under the pointer.
            widget = render_widget(hwnd)
            if not widget:
                raise ValueError("Aucune page visible dans cette fenêtre")
            rect = gui.GetWindowRect(widget)
        box = (
            max(box[0], rect[0]),
            max(box[1], rect[1]),
            min(box[2], rect[2]),
            min(box[3], rect[3]),
        )
        scroll = None
        if docs:
            try:
                scroll = docs[0].iface_scroll
                if not scroll.CurrentVerticallyScrollable:
                    scroll = None
            except Exception:
                scroll = None
            docs[0].set_focus()
        else:
            wheel = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
            move_pointer(*wheel)
        check_focus(hwnd)
        if scroll:
            scroll.SetScrollPercent(-1, 0)
        elif wheel:
            for _ in range(20):
                page_wheel(hwnd, wheel, WHEEL_DELTA * 50)
        else:
            mouse.hotkey("ctrl", "home")
        ident = str(uuid.uuid4())
        folder = cache / ident
        folder.mkdir(parents=True)
        offsets = []
        previous = None
        exhausted = False
        for index in range(a["max_slices"]):
            time.sleep(0.45)
            check_focus(hwnd)
            im = capture(box)
            sample = im.resize((64, 64)).tobytes()
            if sample == previous:
                exhausted = True
                break
            previous = sample
            offset = None if index else 0
            if scroll:
                percent = scroll.CurrentVerticalViewSize
                if percent > 0:
                    offset = round(
                        im.height
                        * (100 / percent - 1)
                        * scroll.CurrentVerticalScrollPercent
                        / 100
                    )
            offsets.append(offset)
            im.save(folder / f"{index + 1}.jpg", quality=78)
            if index == 0:
                first = render(im, 0, 0, a)
            if scroll and scroll.CurrentVerticalScrollPercent >= 99.999:
                exhausted = True
                break
            if index + 1 < a["max_slices"]:
                check_focus(hwnd)
                if scroll:
                    scroll.Scroll(
                        2, 3
                    )  # NoAmount horizontally, LargeIncrement vertically
                elif wheel:
                    # About 70 % of the viewport per step; stitch() drops the overlap.
                    notches = max(1, int((box[3] - box[1]) * 0.7 / 100))
                    page_wheel(hwnd, wheel, -WHEEL_DELTA * notches)
                else:
                    mouse.press("pagedown")
        (folder / "page.json").write_text(json.dumps(offsets))
        if a.get("text"):
            pages = []
            for index in range(len(offsets)):
                with Image.open(folder / f"{index + 1}.jpg") as im:
                    pages.append(ocr_lines(im.convert("RGB")))
            text = stitch(pages)
            return dict(window=str(hwnd), title=gui.GetWindowText(hwnd), source="ocr_stitched_slices",
                        capture=ident, slices=len(offsets), limit_reached=not exhausted,
                        length=len(text), text=text)
        return dict(
            capture=ident,
            slices=len(offsets),
            page_y=offsets[0],
            limit_reached=not exhausted,
            **first,
        )
    # Preserve excerpt coordinates and the session cache for whole-window ASCII.
    # Region/screen grids remain coordinate observations, never clickable snapshots.
    if tool == "desktop_observe" and hwnd and not a.get("region") and a.get("mode", "ascii") == "ascii":
        defaults = {"columns": 160, "simplified": True, "feedback": "ascii", **a}
        ident, info = store_snapshot(hwnd, defaults, cache, box, read_window(hwnd, box), cache_read=True)
        return dict(capture=ident, window=str(hwnd), x=box[0], y=box[1], width=box[2]-box[0],
                    height=box[3]-box[1], columns=info["columns"], rows=len(info["grid"]),
                    feedback=info["feedback"], grid_text=compact_grid(info["grid"]))
    if a.get("region"):
        r = a["region"]
        crop = r["x"], r["y"], r["x"] + r["width"], r["y"] + r["height"]
        if crop[0] < box[0] or crop[1] < box[1] or crop[2] > box[2] or crop[3] > box[3]:
            raise ValueError("Zone hors de la cible")
        box = crop
    pid = win32process.GetWindowThreadProcessId(hwnd)[1] if hwnd else None
    result = render(read_window(hwnd, box), *box[:2], a, cache, ("observe", hwnd, pid, box))
    if hwnd and tool == "desktop_observe":
        result["window"] = str(hwnd)
    return result


PASSIVE_TOOLS = {
    "desktop_list", "desktop_windows", "desktop_taskbar", "desktop_tabs", "desktop_observe",
    "desktop_ascii", "desktop_sweep", "desktop_slice",
}


def dispatch(req):
    global room_desktop, room_number, browser_root, own_desktop, target_desktop
    tool, args, cache = req["tool"], req["args"], Path(req["cache"])
    target_desktop = int(req["desktop"]) if req.get("desktop") is not None else None
    if tool == "desktop_click_excerpt" and target_desktop is None:
        manifest = cache / args["capture"] / "ascii.json"
        if manifest.is_file():
            saved_desktop = json.loads(manifest.read_text(encoding="utf8")).get("desktop_id")
            if saved_desktop:
                from room_desktop import get_virtual_desktops
                desktops = get_virtual_desktops()
                target_desktop = next((i+1 for i,d in enumerate(desktops) if str(d.id) == saved_desktop), None)
                if target_desktop is None:
                    raise ValueError("Le bureau de cette capture a été fermé. Refaites la capture.")
    if target_desktop is not None and target_desktop < 1:
        raise ValueError("Numéro de bureau virtuel invalide.")
    room = int(req["room"]) if req.get("room") is not None else None
    room_number = room
    browser_root = req.get("browserRoot")
    if room is not None and room < 1:
        raise ValueError("Numéro de room invalide.")
    passive = tool in PASSIVE_TOOLS
    if tool == "desktop_slice":
        return run(tool, args, cache)
    owner = req["owner"]
    session = win32ts.ProcessIdToSessionId(os.getpid())
    database = Path(tempfile.gettempdir()) / f"mind-wake-desktop-lease-{session}.sqlite"
    db = sqlite3.connect(database, isolation_level=None)
    try:
        if room is not None or target_desktop is not None:
            from room_desktop import resolve, switch, by_number, VirtualDesktop
        if room is not None:
            own_desktop = room_desktop = resolve(db, room)
        if target_desktop is None and room is not None:
            # A numeric window ID (desktop_list) designates that window wherever it is:
            # the call then targets its virtual desktop, exactly as with desktop=N.
            from room_desktop import number_of
            number = number_of(window_id(args.get("window")))
            if number is not None and str(by_number(number).id) != str(own_desktop.id):
                target_desktop = number
        if target_desktop is not None:
            room_desktop = by_number(target_desktop)
        # Reading a named window uses PrintWindow on an inactive desktop. A whole
        # screen, the taskbar, or the foreground window needs the correct live view.
        live_view = tool == "desktop_taskbar" or (
            tool in ("desktop_ascii", "desktop_observe") and not args.get("window")
        )
        if passive and not live_view:
            return run(tool, args, cache)
        scoped = room_desktop is not None
        # Every focus-requiring call (input, desktop switch, live view) waits its turn in
        # a FIFO shared by all MCP servers; a dead or frozen holder is dropped.
        from desktop_input_lock import DesktopInputLock, WAIT_SECONDS
        # A shared virtual desktop (desktop=N) has one control lease for every room;
        # a caller blocked by another agent's lease waits its turn in the same queue.
        slot = None if passive else (-target_desktop if target_desktop is not None else (room or 0))
        queue = DesktopInputLock(owner=owner, room=room, tool=tool, slot=slot).acquire()
        # Windows mutex kept for workers still running the previous code.
        try:
            lock = win32event.CreateMutex(None, False, r"Local\MindWakeDesktopInput")
            acquired = win32event.WaitForSingleObject(lock, int(WAIT_SECONDS * 1000)) in (0, 128)
        except BaseException:
            queue.release()
            raise
        try:
            if not acquired:
                raise ValueError("Bureau occupé par un ancien processus desktop (verrou Windows). Réessayez après son action.")
            # Only input shows the target desktop. Reads (whole screen, foreground
            # window, taskbar) never switch the visible desktop: see read_window.
            previous = VirtualDesktop.current() if scoped and not passive else None
            try:
                if previous:
                    switch(room_desktop)
                if tool == "desktop_click_excerpt" and previous and previous.id != room_desktop.id:
                    return run(tool, args, cache, lambda: switch(previous))
                return run(tool, args, cache)
            finally:
                if previous and previous.id != room_desktop.id and VirtualDesktop.current().id == room_desktop.id:
                    switch(previous)
        finally:
            try:
                if acquired:
                    win32event.ReleaseMutex(lock)
                lock.Close()
            finally:
                queue.release()
    finally:
        db.close()


if __name__ == "__main__":
    try:
        from desktop_ascii_diff import capture_response
        request = json.loads(sys.stdin.buffer.read())
        from desktop_call_vision import active_calls, record
        vision_root = os.environ.get("MIND_WAKE_DATA_DIR")
        if vision_root:
            try:
                call_vision_sessions = active_calls(Path(vision_root), request.get("room"))
            except (ValueError, OSError, sqlite3.Error) as exc:
                print(f"Vision appel: {exc}", file=sys.stderr)
        response = capture_response(request, dispatch, lambda: room_desktop.id if room_desktop else None)
        if call_vision_sessions:
            try:
                record(Path(vision_root), call_vision_sessions, request, response)
            except (ValueError, OSError, sqlite3.Error) as exc:
                print(f"Vision appel: {exc}", file=sys.stderr)
        for item in response if isinstance(response, list) else [response]:
            if isinstance(item, dict):
                item.pop("_vision_jpeg", None)
        print(json.dumps(response, ensure_ascii=True))
    except Exception as exc:
        sys.exit(str(exc))
