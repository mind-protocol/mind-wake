"""Reliable text insertion for desktop_act op=text.

Why: web editors that rewrite their value after each keystroke (React controlled inputs,
LinkedIn composers and typeaheads) drop characters that arrive in bursts. The previous
path sent ~1/64 of the text per SendInput batch (several characters at once).

Strategy (method="auto"):
  * a text of PASTE_MIN chars or more goes through the clipboard (one Ctrl+V, a single
    input event for the page); the human's clipboard is saved first and restored after
    the field shows the text, and the temporary content stays out of clipboard history;
  * shorter text, or method="keys", is typed one character per SendInput, paced;
  * the focused field is read back through UI Automation before and after, and the
    report says whether the text is effectively present (verified true/false/None).
  If a paste inserts nothing (paste blocked, no editable focus) the text is typed instead.
"""
import ctypes
import time
from ctypes import wintypes

PASTE_MIN = 4
KEY_DELAY = 0.03
SETTLE_SECONDS = 2.0
POLL_SECONDS = 0.05
ECHO_SECONDS = 0.25
# Total time spent on per-keystroke read-backs (each costs 20-200 ms in Chrome).
ECHO_BUDGET = 20.0

# Clipboard formats holding GDI handles rather than memory: not restorable as bytes.
HANDLE_FORMATS = {2, 3, 9, 14}  # CF_BITMAP, CF_METAFILEPICT, CF_PALETTE, CF_ENHMETAFILE


def normalize(text):
    """Comparison form: line endings, non-breaking spaces and trailing blanks ignored."""
    if text is None:
        return None
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ").replace("​", "")
    return "\n".join(line.rstrip() for line in text.split("\n")).strip("\n")


def check_inserted(before, after, text):
    """Verdict on a read-back: True, False or None (field unreadable)."""
    if after is None:
        return None
    want, now = normalize(text), normalize(after)
    if want in now:
        # Already there before, at the same count: the insertion itself did not happen.
        if before is not None and normalize(before).count(want) >= now.count(want):
            return False
        return True
    return False


def describe(before, after, text):
    """Short diagnostic for a failed insertion, without echoing the whole field."""
    if after is None:
        return "champ illisible par UI Automation"
    want, now = normalize(text), normalize(after)
    prior = normalize(before) if before is not None else ""
    added = len(now) - len(prior)
    if now.startswith(prior):
        now = now[len(prior):]  # compare the inserted part only (field appended at the end)
    i = 0
    while i < min(len(want), len(now)) and want[i] == now[i]:
        i += 1
    return f"{added} caractères ajoutés sur {len(want)} attendus" + (
        f", première divergence au caractère {i + 1}" if added > 0 else "")


# --- UI Automation read-back -------------------------------------------------------------

def focused_text(hwnd):
    """Text of the focused editable element of hwnd's process, or None if unreadable."""
    try:
        import win32process
        from pywinauto.uia_defines import IUIA
        from comtypes.gen import UIAutomationClient as UIA

        api = IUIA().iuia
        el = api.GetFocusedElement()
        if el is None:
            return None
        if el.CurrentProcessId != win32process.GetWindowThreadProcessId(hwnd)[1]:
            return None
        if el.CurrentControlType not in (UIA.UIA_EditControlTypeId, UIA.UIA_DocumentControlTypeId,
                                         UIA.UIA_ComboBoxControlTypeId, UIA.UIA_GroupControlTypeId,
                                         UIA.UIA_CustomControlTypeId, UIA.UIA_PaneControlTypeId):
            return None
        value = None
        try:
            pattern = el.GetCurrentPattern(UIA.UIA_ValuePatternId)
            if pattern:
                value_pattern = pattern.QueryInterface(UIA.IUIAutomationValuePattern)
                if not value_pattern.CurrentIsReadOnly:
                    value = value_pattern.CurrentValue or ""
                    if value:
                        return value
        except Exception:
            pass
        try:
            pattern = el.GetCurrentPattern(UIA.UIA_TextPatternId)
            if pattern:
                return pattern.QueryInterface(UIA.IUIAutomationTextPattern).DocumentRange.GetText(-1) or ""
        except Exception:
            pass
        return value
    except Exception:
        return None


def wait_for(hwnd, before, text, deadline):
    """Poll the field until the text appears or the deadline passes; last verdict and value."""
    after = focused_text(hwnd)
    verdict = check_inserted(before, after, text)
    while verdict is False and time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        after = focused_text(hwnd)
        verdict = check_inserted(before, after, text)
    return verdict, after


# --- Clipboard -----------------------------------------------------------------------------

def _open_clipboard(cb, tries=40):
    for _ in range(tries):
        try:
            cb.OpenClipboard()
            return
        except Exception:
            time.sleep(0.025)
    raise OSError("Presse-papiers occupé par une autre application.")


def save_clipboard(cb):
    """Every memory-backed format of the current clipboard, in enumeration order."""
    saved = []
    _open_clipboard(cb)
    try:
        fmt = cb.EnumClipboardFormats(0)
        while fmt:
            if fmt not in HANDLE_FORMATS:
                try:
                    saved.append((fmt, cb.GetClipboardData(fmt)))
                except Exception:
                    pass  # delayed rendering refused or private format: skipped
            fmt = cb.EnumClipboardFormats(fmt)
    finally:
        cb.CloseClipboard()
    return saved


def put_text(cb, text):
    """Place text alone on the clipboard, excluded from Win+V history and cloud sync."""
    _open_clipboard(cb)
    try:
        cb.EmptyClipboard()
        cb.SetClipboardData(cb.CF_UNICODETEXT, text)
        for name, value in (("ExcludeClipboardContentFromMonitorProcessing", b"\0\0\0\0"),
                            ("CanIncludeInClipboardHistory", b"\0\0\0\0"),
                            ("CanUploadToCloudClipboard", b"\0\0\0\0")):
            try:
                cb.SetClipboardData(cb.RegisterClipboardFormat(name), value)
            except Exception:
                pass
    finally:
        cb.CloseClipboard()


def restore_clipboard(cb, saved):
    _open_clipboard(cb)
    try:
        cb.EmptyClipboard()
        for fmt, data in saved:
            try:
                cb.SetClipboardData(fmt, data)
            except Exception:
                pass
    finally:
        cb.CloseClipboard()


# --- Keystrokes ----------------------------------------------------------------------------

class _Keyboard(ctypes.Structure):
    _fields_ = [("vk", wintypes.WORD), ("scan", wintypes.WORD), ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("extra", ctypes.c_size_t)]


class _Mouse(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("data", wintypes.DWORD),
                ("flags", wintypes.DWORD), ("time", wintypes.DWORD), ("extra", ctypes.c_size_t)]


class _Payload(ctypes.Union):
    _fields_ = [("keyboard", _Keyboard), ("mouse", _Mouse)]


class _Input(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("payload", _Payload)]


def unicode_events(char):
    """KEYEVENTF_UNICODE down/up pairs for one character (two code units off the BMP)."""
    data = char.encode("utf-16-le")
    events = []
    for i in range(0, len(data), 2):
        unit = int.from_bytes(data[i:i + 2], "little")
        for flags in (4, 6):  # KEYEVENTF_UNICODE, | KEYEVENTF_KEYUP
            events.append(_Input(1, _Payload(keyboard=_Keyboard(0, unit, flags, 0, 0))))
    return events


def send(events):
    sent = ctypes.windll.user32.SendInput(len(events), (_Input * len(events))(*events), ctypes.sizeof(_Input))
    if sent != len(events):
        raise OSError("Saisie Unicode incomplète")


def type_keys(text, check_focus, delay=KEY_DELAY, read=None):
    """One character per SendInput, paced so the page renders between keystrokes.

    With read (current field text, or None if unreadable), each keystroke also waits,
    up to ECHO_SECONDS, until the field length has grown: a field that re-renders slowly
    then receives the next character only once the previous one is in. Beyond ECHO_BUDGET
    seconds of read-backs (long text), the rest is only paced."""
    start = read() if read else None
    if start is None:
        read = None
    else:
        base = len(start)
        budget_end = time.monotonic() + ECHO_BUDGET
    for index, char in enumerate(text):
        if index % 16 == 0:
            check_focus()
        send(unicode_events(char))
        time.sleep(delay * (1.6 if char.isspace() or not char.isalnum() else 1))
        if read and time.monotonic() > budget_end:
            read = None
        if read:
            deadline = time.monotonic() + ECHO_SECONDS
            while time.monotonic() < deadline:
                now = read()
                if now is None or len(now) >= base + index + 1:
                    break
                time.sleep(0.01)


def paste(text, check_focus, press_paste, hwnd, before, cb=None):
    """Ctrl+V the text, wait for the field to show it, then give the clipboard back."""
    if cb is None:
        import win32clipboard as cb
    saved = save_clipboard(cb)
    try:
        put_text(cb, text)
        check_focus()
        press_paste()
        verdict, after = wait_for(hwnd, before, text, time.monotonic() + SETTLE_SECONDS)
        if verdict is None:
            time.sleep(0.4)  # unreadable field: leave the page time to read the clipboard
    finally:
        restore_clipboard(cb, saved)
    return verdict, after


def insert_text(text, hwnd, check_focus, press_paste, method="auto"):
    """Insert text in the focused field of hwnd; returns the verification report."""
    if method not in ("auto", "paste", "keys"):
        raise ValueError(f"Méthode de saisie inconnue : {method!r}")
    check_focus()
    before = focused_text(hwnd)
    use_paste = method == "paste" or (method == "auto" and len(text) >= PASTE_MIN)
    report = dict(chars=len(text))
    if use_paste:
        verdict, after = paste(text, check_focus, press_paste, hwnd, before)
        unchanged = after is not None and before is not None and normalize(after) == normalize(before)
        if verdict is False and unchanged and method == "auto":
            # Paste refused or swallowed by the page: nothing landed, type it instead.
            report["fallback"] = "keys"
            report["paste"] = "aucun effet"
            use_paste = False
        else:
            report.update(method="paste", verified=verdict)
            if verdict is False:
                report["detail"] = describe(before, after, text)
            return report
    type_keys(text, check_focus, read=lambda: focused_text(hwnd))
    verdict, after = wait_for(hwnd, before, text, time.monotonic() + SETTLE_SECONDS)
    report.update(method="keys", verified=verdict)
    if verdict is False:
        report["detail"] = describe(before, after, text)
    return report
