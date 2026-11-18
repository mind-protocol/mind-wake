"""Carry a rendered control's complete pixel rectangle through excerpt matching."""

from collections import Counter
from itertools import chain


def _number_controls(lines, controls, text_spans):
    ordered = sorted(controls, key=lambda s: (s[0], s[3]+s[5], s[4]+s[6], s))
    labels = ["".join(lines[r][a+1:b-1]) for r,a,b,*_ in ordered]
    counts = Counter(labels)
    reserved = set(labels)
    serial = Counter()
    tokens = {}
    for span, label in zip(ordered, labels):
        if counts[label] > 1:
            serial[label] += 1
            while f"{label} #{serial[label]}" in reserved:
                serial[label] += 1
            numbered = f"{label} #{serial[label]}"
            reserved.add(numbered)
            tokens[span] = f"[{numbered}]"
    if not tokens:
        return controls

    rows, cols = len(lines), len(lines[0])
    free = [[char == " " for char in row] for row in lines]
    for row, start, end, *_ in text_spans:
        free[row][start:end] = [False] * (end-start)
    for span in controls:
        row, start, end = span[:3]
        free[row][start:end] = [span in tokens] * (end-start)

    # Pack adjacent tokens together, so extending one to the right never
    # erases a neighbour. Unrelated text and its click mapping stay in place.
    runs = {}
    for span in tokens:
        row, start, end = span[:3]
        while start and free[row][start-1]:
            start -= 1
        while end < cols and free[row][end]:
            end += 1
        runs.setdefault((row,start,end), []).append(span)
    positions = {}
    crowded = []
    for (row, start, end), group in runs.items():
        needed = sum(len(tokens[s]) for s in group)
        if needed > end-start:
            for span in group:
                a, b = span[1:3]
                free[row][a:b] = [False] * (b-a)
            crowded.extend(group)
            continue
        for span in group:
            length = len(tokens[span])
            col = min(max(span[1], start), end-needed)
            positions[span] = (row, col)
            free[row][col:col+length] = [False] * length
            start = col+length
            needed -= length

    # Preserve an unambiguous bracketed alias even on a grid with no spare
    # A circled identifier occupies one cell when a suffix cannot fit.
    short_ids = (chr(n) for n in chain(range(0x2460, 0x2474), range(0x3251, 0x3260),
                                      range(0x32B1, 0x32C0), range(0x24B6, 0x24EA))
                 if chr(n) not in reserved)
    for span in crowded:
        row, start, end = span[:3]
        length = len(tokens[span])
        free[row][start:end] = [True] * (end-start)
        for r in sorted(range(rows), key=lambda n: abs(n-row)):
            slots = (i for i in range(cols-length+1) if all(free[r][i:i+length]))
            col = min(slots, key=lambda i: abs(i-start), default=None)
            if col is not None:
                positions[span] = (r, col)
                free[r][col:col+length] = [False] * length
                break
        else:
            identifier = next(short_ids, None)
            if identifier is not None:
                tokens[span] = f"[{identifier}]"
                positions[span] = (row, start)
            free[row][start:end] = [False] * (end-start)

    for row, start, end, *_ in positions:
        lines[row][start:end] = [" "] * (end-start)
    updated = []
    for span in controls:
        if span in positions:
            row, start = positions[span]
            token = tokens[span]
            lines[row][start:start+len(token)] = token
            span = (row, start, start+len(token), *span[3:])
        updated.append(span)
    return updated


# UIA ToggleState: Off, On, Indeterminate. Rendered inside the control token, e.g. [☑ Notifications].
TOGGLE_MARKS = {0: "☐", 1: "☑", 2: "◪"}


def toggle_state(element, uia):
    """Cached UIA Toggle state (0/1/2) of a switch or check box, None when it has none."""
    from comtypes import COMError
    try:
        if not element.GetCachedPropertyValue(uia.UIA_IsTogglePatternAvailablePropertyId):
            return None
        state = element.GetCachedPropertyValue(uia.UIA_ToggleToggleStatePropertyId)
    except (COMError, OSError):
        return None
    return state if isinstance(state, int) and state in TOGGLE_MARKS else None


def window_targets(hwnd, box):
    from comtypes import COMError
    from pywinauto.uia_defines import IUIA
    from comtypes.gen import UIAutomationClient as uia

    api = IUIA().iuia
    role = uia.UIA_ControlTypePropertyId
    conditions = [api.CreatePropertyCondition(role, getattr(uia, "UIA_" + name + "ControlTypeId"))
                  for name in ("Button", "Hyperlink", "MenuItem", "CheckBox", "RadioButton",
                               "TabItem", "SplitButton", "ComboBox")]
    for pattern in ("Invoke", "Toggle", "SelectionItem", "ExpandCollapse"):
        conditions.append(api.CreatePropertyCondition(
            getattr(uia, "UIA_Is" + pattern + "PatternAvailablePropertyId"), True))
    condition = conditions.pop()
    for extra in conditions:
        condition = api.CreateOrCondition(condition, extra)
    for prop, value in ((uia.UIA_IsOffscreenPropertyId, False), (uia.UIA_IsEnabledPropertyId, True)):
        condition = api.CreateAndCondition(condition, api.CreatePropertyCondition(prop, value))
    cache = api.CreateCacheRequest()
    for prop in (uia.UIA_NamePropertyId, uia.UIA_BoundingRectanglePropertyId,
                 uia.UIA_IsTogglePatternAvailablePropertyId, uia.UIA_ToggleToggleStatePropertyId):
        cache.AddProperty(prop)
    targets = []
    try:
        root = api.ElementFromHandle(hwnd)
        elements = root.FindAllBuildCache(uia.TreeScope_Descendants, condition, cache)
        for i in range(elements.Length):
            element = elements.GetElement(i)
            rect = element.CachedBoundingRectangle
            if (box[0] <= rect.left < rect.right <= box[2]
                    and box[1] <= rect.top < rect.bottom <= box[3]):
                target = (rect.left-box[0], rect.top-box[1], rect.right-box[0],
                          rect.bottom-box[1], element.CachedName or "")
                state = toggle_state(element, uia)
                targets.append(target if state is None else (*target, state))
    except (COMError, OSError):
        pass
    return targets


def annotate(grid, spans, image, targets):
    rows, cols = len(grid), len(grid[0])
    width, height = image.size
    lines = [list(line) for line in grid]
    occupied = set()
    control_spans = []
    # Render the most specific control first in a nested accessibility tree.
    for left, top, right, bottom, name, *state in sorted(
            set(targets), key=lambda t: ((t[2]-t[0])*(t[3]-t[1]), t)):
        center_x, center_y = (left+right)/2, (top+bottom)/2
        row = min(rows-1, int(center_y*rows/height))
        col = min(cols-1, int(center_x*cols/width))
        words = [s for s in spans if left <= (s[3]+s[5])/2 < right
                 and top <= (s[4]+s[6])/2 < bottom]
        if words:
            # Multi-line widgets can contain descriptions on other rows.
            row = min((s[0] for s in words), key=lambda r: abs(r-row))
            words = [s for s in words if s[0] == row]
            first, last = min(s[1] for s in words), max(s[2] for s in words)
            label = " ".join(grid[row][s[1]:s[2]] for s in sorted(words))
            if name and label.endswith(" " + name) and len(label)-len(name) <= 3:
                prefix = label[:-len(name)].strip()
                if prefix not in "+×☰›⌃‹⌄→↑←↓⊡":
                    label = name
            anchor = first - 1
        else:
            first = last = col
            # Some providers expose hover-only controls even on a flat, empty
            # patch of screen. Don't invent a label there.
            if max(hi-lo for lo,hi in image.crop((left,top,right,bottom)).convert("RGB").getextrema()) < 12:
                continue
            symbol = grid[row][col]
            label = symbol if symbol in "+×☰›⌃‹⌄→↑←↓⊡" else " ".join(name.split())
            if not label or len(label) > 48:
                continue
            anchor = col - (len(label)+2)//2
        mark = TOGGLE_MARKS.get(state[0]) if state else None
        tokens = ["[" + label + "]"]
        if mark and not label.startswith(mark):
            tokens.insert(0, "[" + mark + " " + label + "]")  # fall back to the bare label when cramped
        tokens = [t for t in tokens if len(t) <= cols]
        if not tokens:
            continue
        # Only borrow adjacent unused cells. Keep other text and targets intact.
        def available(i):
            return ((row, i) not in occupied and
                    (any(s[1] <= i < s[2] for s in words) or
                     lines[row][i] in " ─│┼○□" or (not words and i == col and lines[row][i] == label)))
        for token, offset in ((t, o) for t in tokens for o in (0, 1, -1, 2, -2)):
            start = min(cols-len(token), max(0, anchor+offset))
            end = start + len(token)
            if not all(available(i) for i in range(min(start,first), max(end,last))):
                continue
            lines[row][first:last] = [" "] * (last-first)
            lines[row][start:end] = token
            occupied.update((row,i) for i in range(start,end))
            control_spans.append((row,start,end,left,top,right,bottom))
            break
    preserved = [s for s in spans if not any((s[0], i) in occupied for i in range(s[1], s[2]))]
    control_spans = _number_controls(lines, control_spans, preserved)
    return ["".join(line) for line in lines], control_spans + preserved, control_spans
