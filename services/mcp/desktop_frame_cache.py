"""Reuse raw OCR in a private session, always rendering click mappings for the current frame."""
import io
import json
import sqlite3
from contextlib import closing

from PIL import Image, ImageChops


def incremental_labels(image, previous, dirty, recognize):
    width, height = image.size
    l,t,r,b = dirty
    l,t,r,b = max(0,l-48),max(0,t-28),min(width,r+48),min(height,b+28)
    # Never cut a previously known word at a crop edge. Include the rest of
    # its OCR line so spacing and click spans can be reconstructed together.
    pending = list(previous)
    while True:
        kept = []
        for group in pending:
            if any(x < r and rr > l and y < b and bb > t for x,y,rr,bb,_ in group):
                for x,y,rr,bb,_ in group:
                    l,t,r,b = min(l,max(0,x-5)),min(t,max(0,y-5)),max(r,min(width,rr+5)),max(b,min(height,bb+5))
            else:
                kept.append(group)
        if len(kept) == len(pending):
            break
        pending = kept
    if (r-l)*(b-t) > width*height*0.35:
        return recognize(image)
    local = recognize(image.crop((l,t,r,b)))
    # A new word continuing outside the crop may have no prior box.
    if any((l and x <= 1) or (t and y <= 1) or (r < width and rr >= r-l-1)
           or (b < height and bb >= b-t-1) for group in local for x,y,rr,bb,_ in group):
        return recognize(image)
    return kept + [[(x+l,y+t,rr+l,bb+t,word) for x,y,rr,bb,word in group] for group in local]


def cached_frame(cache, key, image, targets, recognize, render, reuse):
    target_key = json.dumps(key)
    semantics = json.dumps(sorted(targets))
    with closing(sqlite3.connect(cache / "ocr-frames.sqlite", timeout=90)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS frames (key TEXT PRIMARY KEY, png BLOB, labels TEXT, semantics TEXT, result TEXT)")
        old = db.execute("SELECT png, labels, semantics, result FROM frames WHERE key=?", (target_key,)).fetchone() if reuse else None
        labels = None
        if old:
            with Image.open(io.BytesIO(old[0])) as before:
                if before.size == image.size:
                    dirty = ImageChops.difference(before, image).getbbox()
                    if dirty is None and old[2] == semantics:
                        return json.loads(old[3])
                    previous = [[tuple(word) for word in group] for group in json.loads(old[1])]
                    labels = previous if dirty is None else incremental_labels(image, previous, dirty, recognize)
        if labels is None:
            labels = recognize(image)
        encoded = json.dumps(labels, ensure_ascii=False)
        result = render(labels)
        png = io.BytesIO()
        image.save(png, format="PNG", compress_level=1)
        db.execute("INSERT OR REPLACE INTO frames VALUES (?,?,?,?,?)",
                   (target_key, png.getvalue(), encoded, semantics, json.dumps(result, ensure_ascii=False)))
        return result
