import csv
import io
import math
import os
from pathlib import Path
import shutil
import subprocess

import numpy as np
from PIL import Image, ImageOps

# Each cell holds four by eight luminance samples. Masks describe ideal ink
# coverage, independent of the viewing terminal's font rasterizer.
Y, X = np.mgrid[:8, :4]
LEFT, RIGHT = X < 2, X >= 2
TOP, BOTTOM = Y < 4, Y >= 4


def palette():
    masks = {}

    def add(char, mask):
        masks[char] = np.broadcast_to(mask, (8, 4)).astype(np.float32).ravel()

    for i, char in enumerate(" ░▒▓█"):
        add(char, i / 4)
    for i, char in enumerate("▁▂▃▄▅▆▇", 1):
        add(char, Y >= 8 - i)
    for i, char in enumerate("▏▎▍▌▋▊▉", 1):
        add(char, np.clip(i / 2 - X, 0, 1))
    for char, mask in zip("▀▐▔▕", [TOP, RIGHT, Y == 0, X == 3]):
        add(char, mask)
    quadrants = [TOP & LEFT, TOP & RIGHT, BOTTOM & LEFT, BOTTOM & RIGHT]
    for bits, char in zip([1, 2, 4, 8, 9, 6, 7, 11, 13, 14], "▘▝▖▗▚▞▛▜▙▟"):
        add(char, sum(mask for i, mask in enumerate(quadrants) if bits & (1 << i)))
    for char, directions in zip("─│┌┐└┘├┤┬┴┼", ["lr","ud","rd","ld","ru","lu","urd","uld","lrd","lru","lrud"]):
        mask = np.zeros((8, 4))
        for d in directions:
            if d in "lr":
                mask += ((LEFT if d == "l" else RIGHT) & (Y == 4))
            else:
                mask += ((TOP if d == "u" else BOTTOM) & (X == 2))
        add(char, np.minimum(mask, 1))
    diagonal = np.abs(X - Y * 3 / 7) < 0.65
    add("╲", diagonal)
    add("╱", diagonal[:, ::-1])
    add("╳", diagonal | diagonal[:, ::-1])
    # Standard Unicode braille bit positions, top to bottom in each column.
    dots = np.array([[0, 3], [1, 4], [2, 5], [6, 7]])[Y // 2, X // 2]
    for bits in range(1, 256):
        add(chr(0x2800 + bits), ((bits >> dots) & 1) * 0.52)
    return list(masks), np.stack(list(masks.values()))


CHARS, MASKS = palette()
# Bias average coverage as well as pixelwise shape similarity.
MEANS = MASKS.mean(axis=1)
COST = (MASKS ** 2).mean(axis=1) + MEANS ** 2


def read_labels(image, min_confidence=0):
    exe = shutil.which("tesseract")
    if not exe:
        exe = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Tesseract-OCR/tesseract.exe"
        if not exe.is_file():
            raise ValueError("Installez Tesseract OCR ou désactivez l’OCR.")
    cmd = [str(exe), "stdin", "stdout", "--psm", "11"]
    models = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "capture-unicode/tessdata"
    if (models / "fra.traineddata").is_file():
        cmd.extend(["--tessdata-dir", str(models), "-l", "fra"])
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    proc = subprocess.run(cmd + ["-c", "tessedit_create_tsv=1"], input=buffer.getvalue(), capture_output=True,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if proc.returncode:
        raise ValueError(proc.stderr.decode("utf-8", errors="replace").strip())
    lines = {}
    for word in csv.DictReader(io.StringIO(proc.stdout.decode("utf-8")), delimiter="\t", quoting=csv.QUOTE_NONE):
        if word["level"] != "5" or not word["text"].strip() or float(word["conf"]) < min_confidence:
            continue
        key = tuple(word[k] for k in ("block_num", "par_num", "line_num"))
        lines.setdefault(key, []).append(word)
    labels = []
    for words in lines.values():
        group = []
        for word in words:
            x, y, w, h = (int(word[k]) for k in ("left", "top", "width", "height"))
            if group and x - group[-1][2] > 1.5 * max(h, group[-1][3] - group[-1][1]):
                labels.append(group)
                group = []
            group.append((x, y, x + w, y + h, word["text"]))
        labels.append(group)
    return labels


def visible_underlines(image, labels):
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    marked = set()
    for group in labels:
        for word in group:
            left, top, right, bottom, _ = word
            height = bottom - top
            if right - left < max(8, height):
                continue
            # A thin continuous stripe with contrast on both sides of the
            # baseline is stronger evidence than text color alone.
            for y in range(max(2, bottom - 2), min(image.height - 2, bottom + 3)):
                stripe = rgb[y, left:right]
                above = np.abs(stripe - rgb[y-2, left:right]).max(axis=1)
                below = np.abs(stripe - rgb[y+2, left:right]).max(axis=1)
                if np.mean((above >= 45) & (below >= 45)) >= 0.85:
                    marked.add(word)
                    break
    return marked


def overlay_labels(chars, labels, size, columns, rows, spans=None, underlined=()):
    sx, sy = columns / size[0], rows / size[1]
    by_row = {}
    for group in labels:
        left = min(w[0] for w in group)
        top = min(w[1] for w in group)
        bottom = max(w[3] for w in group)
        line = min(rows - 1, int((top + bottom) * sy / 2))
        by_row.setdefault(line, []).append((round(left * sx), " ".join(w[4] for w in group), group))
        for x, y, right, base, _ in group:
            for r in range(int(y * sy), min(rows, math.ceil(base * sy))):
                start = r * columns + int(x * sx)
                end = r * columns + min(columns, math.ceil(right * sx))
                chars[start:end] = [" "] * (end - start)
    occupied = set()
    rules = []
    for row, groups in by_row.items():
        groups.sort(key=lambda item: item[0])
        remaining = sum(len(label) for _, label, _ in groups) + len(groups) - 1
        if remaining > columns:
            # A dense row must not invalidate all other rows. Keep each group's
            # physical column range, mapping even a shortened word to its box.
            fitted = []
            for index, (anchor, label, words) in enumerate(groups):
                limit = groups[index+1][0]-1 if index+1 < len(groups) else columns
                budget = min(columns, limit) - anchor
                kept = []
                for left, top, right, bottom, word in words:
                    if budget <= 0:
                        break
                    visible = word if len(word) <= budget else word[:budget-1] + "…"
                    kept.append((left, top, right, bottom, visible))
                    budget -= len(visible) + 1
                if kept:
                    fitted.append((anchor, " ".join(w[4] for w in kept), kept))
            groups = fitted
            remaining = sum(len(label) for _, label, _ in groups) + len(groups) - 1
        cursor = 0
        for anchor, label, words in groups:
            x = max(cursor, min(anchor, columns - remaining))
            col = x
            for token in words:
                left, top, right, bottom, word = token
                if spans is not None:
                    spans.append((row, col, col + len(word), left, top, right, bottom))
                if row + 1 < rows and token in underlined:
                    rules.append(((row + 1) * columns + col, len(word)))
                col += len(word) + 1
            start = row * columns + x
            chars[start:start + len(label)] = label
            if underlined:
                occupied.update(range(start, start + len(label)))
            cursor = x + len(label) + 1
            remaining -= len(label) + 1
    for start, length in rules:
        if all(i not in occupied and chars[i] in " ─" for i in range(start, start + length)):
            chars[start:start + length] = ["─"] * length


def structural_lines(gray, labels, columns, rows, visual_targets=None):
    # Detect long edges before rounding to cells, so thin separators survive.
    width, height = columns * 4, rows * 8
    pixels = np.asarray(gray.convert("RGB").resize((width, height), Image.Resampling.BILINEAR),
                        dtype=np.int16)
    visible = np.ones((height, width), dtype=bool)
    for group in labels:
        for x, y, right, base, _ in group:
            visible[max(0, int(y * height / gray.height) - 1):math.ceil(base * height / gray.height) + 1,
                    max(0, int(x * width / gray.width) - 1):math.ceil(right * width / gray.width) + 1] = False

    grid = np.zeros((rows, columns), dtype=np.uint8)
    def mark_edges(samples, mask, target, cell_width, cell_height, bit, min_cells):
        edges = ((np.abs(np.diff(samples, axis=0)).max(axis=2) >= 20) & mask[:-1] & mask[1:])
        for y, edge in enumerate(edges):
            ends = np.flatnonzero(np.diff(edge, prepend=False, append=False))
            for left, right in ends.reshape(-1, 2):
                if right - left >= min_cells * cell_width:
                    target[(y + 1) // cell_height, left // cell_width:(right - 1) // cell_width + 1] |= bit

    mark_edges(pixels, visible, grid, 4, 8, 1, 5)
    mark_edges(pixels.swapaxes(0, 1), visible.T, grid.T, 8, 4, 2, 3)
    chars = [" ─│┼"[value] for value in grid.flat]
    mark_controls(gray, labels, chars, columns, rows, visual_targets)
    return chars


def symbol_templates(cv2):
    # Stroke endpoints in a common frame. Trim before comparing so padding
    # and the aspect ratio of a toolbar do not determine the result.
    shapes = {
        "+": [(3, 16, 29, 16), (16, 3, 16, 29)],
        "×": [(4, 4, 28, 28), (4, 28, 28, 4)],
        "☰": [(3, y, 29, y) for y in (5, 16, 27)],
    }
    masks, glyphs = [], []
    for glyph, strokes in list(shapes.items()) + [
        ("›", [(10, 3, 23, 16), (23, 16, 10, 29)]),
        ("→", [(2, 16, 29, 16), (17, 4, 29, 16), (29, 16, 17, 28)]),
    ]:
        for thickness in (2, 4, 6):
            tile = np.zeros((33, 33), dtype=np.uint8)
            for x, y, end_x, end_y in strokes:
                cv2.line(tile, (x, y), (end_x, end_y), 1, thickness)
            directions = {"›": "›⌃‹⌄", "→": "→↑←↓"}.get(glyph, glyph)
            for turn, direction in enumerate(directions):
                rotation = np.rot90(tile, turn)
                x, y, w, h = cv2.boundingRect(rotation)
                masks.append(cv2.resize(rotation[y:y+h, x:x+w], (24, 24),
                                        interpolation=cv2.INTER_NEAREST).astype(bool))
                glyphs.append(direction)
    return glyphs, np.asarray(masks)


def common_symbols(cv2, rgb, contours, scale):
    boxes = set()
    bars = {}
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if max(w, h) > 66 * scale or max(w, h) < max(6, 9 * scale):
            continue
        if min(w, h) >= 4 and 0.3 <= w / h <= 3.2:
            boxes.add((x, y, w, h))
        if w >= 3 * h:
            bars.setdefault(y, set()).add((x, w, h))
    # Three separate horizontal strokes produce three contours.
    for y, first in bars.items():
        for x, w, h in first:
            for gap in range(max(2, h), w // 2 + 2):
                if not any(abs(bx-x) <= 2 and abs(bw-w) <= 3 for bx, bw, _ in bars.get(y+gap, ())):
                    continue
                for last_y in range(y+2*gap-1, y+2*gap+2):
                    for bx, bw, bh in bars.get(last_y, ()):
                        if abs(bx-x) <= 2 and abs(bw-w) <= 3:
                            boxes.add((min(x,bx), y, max(x+w,bx+bw)-min(x,bx), last_y+bh-y))

    glyphs, templates = symbol_templates(cv2)
    sizes = templates.sum(axis=(1, 2))
    for x, y, w, h in sorted(boxes):
        if x < 2 or y < 2 or x+w+2 > rgb.shape[1] or y+h+2 > rgb.shape[0]:
            continue
        tile = rgb[y-2:y+h+2, x-2:x+w+2].astype(np.int16)
        rim = np.concatenate((tile[0], tile[-1], tile[:,0], tile[:,-1]))
        background = np.median(rim, axis=0)
        if np.mean(np.abs(rim-background).max(axis=1) > 24) > 0.12:
            continue
        contrast = np.abs(tile-background).max(axis=2)
        mask = (contrast > max(28, contrast.max()*0.45)).astype(np.uint8)
        mx, my, mw, mh = cv2.boundingRect(mask)
        if min(mw, mh) < 4 or not (0.3 <= mw/mh <= 3.2):
            continue
        sample = cv2.resize(mask[my:my+mh, mx:mx+mw], (24, 24), interpolation=cv2.INTER_NEAREST)
        overlap = (templates & sample.astype(bool)).sum(axis=(1, 2))
        scores = overlap / (sizes + sample.sum() - overlap)
        best = scores.argmax()
        if scores[best] >= 0.70:
            yield scores[best], (x-2+mx, y-2+my, mw, mh), glyphs[best]


def mark_controls(image, labels, chars, columns, rows, visual_targets=None):
    try:
        import cv2
    except ModuleNotFoundError:
        return

    # Work independently of the terminal resolution. Three-channel Canny also
    # sees boundaries between colors with nearly identical luminance.
    scale = min(1, 1280 / max(image.size))
    size = tuple(max(1, round(n * scale)) for n in image.size)
    rgb = np.asarray(image.convert("RGB").resize(size, Image.Resampling.BILINEAR))
    edges = cv2.Canny(cv2.GaussianBlur(rgb, (3, 3), 0), 45, 95)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    words = [word for group in labels for word in group]
    icons = []
    enclosures = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if min(w, h) < max(7, 12 * scale) or h > 85 * scale or w > 420 * scale:
            continue
        area = cv2.contourArea(contour)
        perimeter = cv2.arcLength(contour, True)
        if area < 0.60 * w * h or not perimeter:
            continue
        left, top, right, bottom = x / scale, y / scale, (x+w) / scale, (y+h) / scale
        inside = [word for word in words if left <= word[0] and word[2] <= right
                  and top <= word[1] and word[3] <= bottom]
        row = min(rows - 1, int((top + bottom) * rows / (2 * image.height)))
        start = int(left * columns / image.width)
        end = min(columns - 1, int(right * columns / image.width))
        if inside:
            if w >= 1.4 * h and area >= 0.82 * w * h and end - start >= 2:
                if (visual_targets is not None and len(inside) <= 5 and w < 7*h
                        and max(word[3] for word in inside) - min(word[1] for word in inside) < 0.8*(bottom-top)
                        and abs(min(word[0] for word in inside) - left - (right - max(word[2] for word in inside))) < h/scale):
                    visual_targets.append((int(left), int(top), int(right), int(bottom), ""))
            continue
        if 0.70 <= w / h <= 1.4 and max(w, h) <= 72 * scale:
            enclosures.append((left,top,right,bottom))
            if any(left < r and l < right and top < b and t < bottom for l, t, r, b, _ in words):
                continue
            circular = 4 * math.pi * area / perimeter**2 > 0.77 and area < 0.84 * w * h
            col = min(columns - 1, int((left + right) * columns / (2 * image.width)))
            icons.append((area, row * columns + col, "○" if circular else "□"))
    # The outer contour wins over details inside the same cell.
    for _, index, glyph in sorted(icons):
        chars[index] = glyph

    for _, (x, y, w, h), glyph in sorted(common_symbols(cv2, rgb, contours, scale)):
        cx, cy = (x + w/2) / scale, (y + h/2) / scale
        col = min(columns - 1, int(cx * columns / image.width))
        row = min(rows - 1, int(cy * rows / image.height))
        chars[row * columns + col] = glyph
        if visual_targets is not None:
            for l,t,r,b in enclosures:
                if (1.35*w/scale <= r-l <= 3.8*w/scale and 1.35*h/scale <= b-t <= 3.8*h/scale
                        and abs(cx-(l+r)/2) <= (r-l)*0.12 and abs(cy-(t+b)/2) <= (b-t)*0.12):
                    visual_targets.append((int(l), int(t), int(r), int(b), glyph))
        # OCR sometimes reads a standalone close icon as the letter X. Keep
        # the original word box so excerpt clicks still target its pixels.
        for group in labels:
            if len(group) == 1:
                l, t, r, b, word = group[0]
                if len(word) == 1 and l <= cx < r and t <= cy < b:
                    group[0] = (l, t, r, b, glyph)


def convert(path, columns, polarity="auto", ocr=True, simplified=False):
    if not 16 <= columns <= 800:
        raise ValueError("Choisir entre 16 et 800 colonnes.")
    with Image.open(path) as source:
        rgba = ImageOps.exif_transpose(source).convert("RGBA")
    gray = Image.new("RGB", rgba.size, "white")
    gray.paste(rgba, mask=rgba.getchannel("A"))
    return render_image(gray, columns, polarity, ocr, simplified)


def recognize_labels(image, simplified, panels=None):
    labels = read_labels(image)
    if simplified:
        from capture_surfaces import detect_surfaces, recover_dark_labels
        from capture_text import recover_small_text
        if panels is None:
            panels, _ = detect_surfaces(image)
        recover_dark_labels(image, panels, labels, read_labels)
        recover_small_text(image, labels, read_labels)
    return labels


def render_image(gray, columns, polarity="auto", ocr=True, simplified=False, spans=None, visual_targets=None, labels=None):
    rows = max(1, round(gray.height * columns / (2 * gray.width)))
    if rows * columns > 1000000:
        raise ValueError("Image très haute. Réduisez le nombre de colonnes.")
    if simplified:
        from capture_surfaces import detect_surfaces, draw_panels
        panels, stops = detect_surfaces(gray)
    if labels is None:
        labels = recognize_labels(gray, simplified, panels if simplified else None) if ocr else []
    if simplified:
        chars = structural_lines(gray, labels, columns, rows, visual_targets)
        draw_panels(chars, panels, gray.size, columns, rows)
        for l, t, r, b in stops:
            labels = [[word for word in group if not
                       (l <= (word[0]+word[2])/2 < r and t <= (word[1]+word[3])/2 < b)]
                      for group in labels]
            labels = [group for group in labels if group]
            labels.append([(l, t, r, b, "⊡")])
            if visual_targets is not None:
                visual_targets.append((l,t,r,b,"⊡"))
    else:
        chars = detailed_chars(gray, polarity, columns, rows)
    underlined = visible_underlines(gray, labels) if simplified and labels else ()
    overlay_labels(chars, labels, gray.size, columns, rows, spans, underlined)
    return "\n".join("".join(chars[k:k + columns]) for k in range(0, len(chars), columns))


def detailed_chars(gray, polarity, columns, rows):
    small = gray.convert("L").resize((columns * 4, rows * 8), Image.Resampling.LANCZOS)
    lum = np.asarray(small, dtype=np.float32) / 255
    dark = polarity == "dark" or (polarity == "auto" and np.median(lum) < 0.5)
    ink = lum if dark else 1 - lum
    cells = ink.reshape(rows, 8, columns, 4).transpose(0, 2, 1, 3).reshape(-1, 32)
    chars = []
    for start in range(0, len(cells), 512):
        batch = cells[start:start + 512]
        scores = COST - 2 * (np.einsum("ij,kj->ik", batch, MASKS) / 32
                             + batch.mean(axis=1)[:, None] * MEANS)
        chars.extend(CHARS[i] for i in scores.argmin(axis=1))
    return chars


