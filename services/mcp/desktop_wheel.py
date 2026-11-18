"""Real mouse-wheel scrolling with measured displacement, for windows without a UIA scroll container.

pyautogui.scroll(n) passes n as raw wheel data: n=-100 is less than one notch (WHEEL_DELTA=120),
which Qt turns into ~1 px and Chrome may ignore. Here every tick is a real SendInput wheel
event of 120 units, and the vertical shift is measured by comparing captures.
"""
import ctypes
import math
import time
from ctypes import wintypes

import numpy as np
import win32gui

WHEEL_DELTA = 120
MOUSEEVENTF_WHEEL = 0x0800
INPUT_MOUSE = 0


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.LONG),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def send_wheel(delta):
    """One wheel event of `delta` units (120 = one notch, positive = away from the user = up)."""
    event = INPUT(type=INPUT_MOUSE)
    event.u.mi = MOUSEINPUT(0, 0, int(delta), MOUSEEVENTF_WHEEL, 0, 0)
    if ctypes.windll.user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT)) != 1:
        raise OSError("SendInput a refusé l'événement molette.")


def _gray(image):
    return np.asarray(image.convert("L"), dtype=np.int16)


def vertical_shift(before, after, min_overlap=0.25, expect=None):
    """Content displacement in pixels between two captures of the same box.

    Positive: content moved up (scrolled down). 0: unchanged. None: changed but no reliable match
    (displacement larger than the viewport, or the view was replaced)."""
    a, b = _gray(before), _gray(after)
    if a.shape != b.shape:
        return None
    changed = np.abs(a - b) > 8
    if not changed.any():
        return 0
    # Restrict to the moving region: fixed headers, side panels and the rest of a modal stay still.
    rows = np.flatnonzero(changed.any(axis=1))
    cols = np.flatnonzero(changed.any(axis=0))
    top, bottom, left, right = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    a, b = a[top:bottom, left:right], b[top:bottom, left:right]
    height, width = a.shape
    if height < 8:
        return None
    # Row signatures: up to 64 column buckets per row.
    buckets = max(1, min(64, width))
    edges = np.linspace(0, width, buckets + 1).astype(int)

    widths = np.diff(edges).astype(np.float32)

    def signature(m):
        return (np.add.reduceat(m.astype(np.float32), edges[:-1], axis=1) / widths).astype(np.float32)

    sa, sb = signature(a), signature(b)
    informative = sa.std(axis=1) > 2  # blank rows match any shift
    limit = int(height * (1 - min_overlap))
    if expect:
        # Calibrated wheel: look near the expected shift first, full search only if that fails.
        spread = max(24, int(abs(expect) * 0.4))
        lo, hi = max(-limit, int(expect) - spread), min(limit, int(expect) + spread)
        best, score = _best_shift(sa, sb, informative, range(lo, hi + 1))
        if best is not None and score >= 0.85:
            return best
    best, score = _best_shift(sa, sb, informative, range(-limit, limit + 1))
    if best is None or score < 0.7:
        return None
    return best


def _best_shift(sa, sb, informative, candidates):
    height = len(sa)
    best, best_score = None, 0.0
    for dy in candidates:
        if dy >= 0:
            pa, pb, keep = sa[dy:], sb[:height - dy], informative[dy:]
        else:
            pa, pb, keep = sa[:height + dy], sb[-dy:], informative[:height + dy]
        if keep.sum() < 4:
            continue
        diff = np.abs(pa[keep] - pb[keep]).max(axis=1)
        score = float((diff < 6).mean())
        if score > best_score + 1e-9 or (abs(score - best_score) <= 1e-9 and best is not None
                                         and abs(dy) < abs(best)):
            best, best_score = dy, score
    return best, best_score


def same(a, b):
    return not np.any(np.abs(_gray(a) - _gray(b)) > 8)


def settle(grab, timeout=1.2, interval=0.04):
    """Capture until two successive frames are identical (smooth scrolling has finished)."""
    previous = grab()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(interval)
        current = grab()
        if same(previous, current):
            return current
        previous = current
    return previous


def guard(hwnd, point):
    if win32gui.GetForegroundWindow() != hwnd:
        raise ValueError("La fenêtre cible a perdu le focus.")
    hit = win32gui.WindowFromPoint(tuple(point))
    if not hit or win32gui.GetAncestor(hit, 2) != hwnd:  # GA_ROOT
        raise ValueError("Le point est hors de la fenêtre cible ou recouvert.")
    if tuple(win32gui.GetCursorPos()) != tuple(point):
        raise ValueError("Le pointeur a bougé pendant le défilement.")


def _step(hwnd, point, grab, before, delta, expect=None):
    guard(hwnd, point)
    remaining = int(delta)
    while remaining:
        part = max(-WHEEL_DELTA, min(WHEEL_DELTA, remaining))
        send_wheel(part)
        remaining -= part
        if remaining:
            time.sleep(0.012)
    after = settle(grab)
    return vertical_shift(before, after, expect=expect), after


def wheel_ticks(hwnd, point, ticks, grab):
    """Send `ticks` real notches (positive up) and measure the total displacement.

    The first notch calibrates; the next ones go in batches small enough to stay measurable.
    `moved` follows the pixels convention: positive = content went up (scrolled down)."""
    before = settle(grab, timeout=0.4)
    height = before.size[1]
    direction = 1 if ticks > 0 else -1
    left, moved, per_notch, unmeasured, stopped = abs(ticks), 0, None, 0, False
    while left:
        batch = 1 if per_notch is None else max(1, min(left, int(height * 0.6 / max(per_notch, 1))))
        expect = None if per_notch is None else -direction * batch * per_notch
        shift, after = _step(hwnd, point, grab, before, direction * batch * WHEEL_DELTA, expect)
        left -= batch
        before = after
        if shift is None:
            unmeasured += batch
        elif shift == 0:
            stopped = True  # end of the list, or nothing scrollable here
            break
        else:
            moved += shift
            per_notch = abs(shift) / batch
    report = dict(requested_ticks=ticks, ticks_sent=abs(ticks) - left, moved=moved, method="wheel")
    if per_notch:
        report["pixels_per_tick"] = round(per_notch, 1)
    if unmeasured:
        report["unmeasured_ticks"] = unmeasured
    if stopped:
        report["stopped"] = "no_movement"
    return report


def wheel_pixels(hwnd, point, pixels, grab, max_steps=40):
    """Scroll `pixels` (positive down) with real wheel events, calibrated on the first notch.

    Partial notches (|delta| < 120) are used to land close to the request: Chrome and Qt honour
    them proportionally. Returns None when the first notch moves nothing."""
    before = settle(grab, timeout=0.4)
    height = before.size[1]
    moved, per_notch = 0, None
    for _ in range(max_steps):
        remaining = pixels - moved
        if per_notch and abs(remaining) < max(4, per_notch * 0.05):
            break
        if per_notch is None:
            delta = -math.copysign(WHEEL_DELTA, remaining)
        else:
            want = max(-height * 0.5, min(height * 0.5, remaining))
            delta = -round(want / per_notch * WHEEL_DELTA)
            if not delta:
                break
        expect = None if per_notch is None else -delta / WHEEL_DELTA * per_notch
        shift, after = _step(hwnd, point, grab, before, delta, expect)
        before = after
        if shift is None:
            continue
        if shift == 0:
            if per_notch is None:
                return None
            break
        moved += shift
        rate = abs(shift) / abs(delta) * WHEEL_DELTA
        per_notch = rate if per_notch is None else (per_notch + rate) / 2
        if (pixels - moved) * pixels < 0:  # overshoot: stop, report the truth
            break
    return dict(requested=pixels, moved=moved, method="wheel")


def key_pixels(hwnd, point, pixels, grab, press, max_keys=30):
    """Last resort: PageDown/PageUp until the requested distance is reached or nothing moves."""
    before = settle(grab, timeout=0.4)
    moved = 0
    key = "pagedown" if pixels > 0 else "pageup"
    for _ in range(max_keys):
        guard(hwnd, point)
        press(key)
        after = settle(grab)
        shift = vertical_shift(before, after, min_overlap=0.05)
        before = after
        if shift == 0:
            break
        if shift is not None:
            moved += shift
        if abs(moved) >= abs(pixels) * 0.75:
            break
    return dict(requested=pixels, moved=moved, method="keys", key=key)


def scroll_any(hwnd, point, pixels, grab, press):
    """Wheel first, keyboard if the wheel moved nothing."""
    report = wheel_pixels(hwnd, point, pixels, grab)
    if report is None:
        report = key_pixels(hwnd, point, pixels, grab, press)
        report["fallback"] = "wheel_no_movement"
    return report
