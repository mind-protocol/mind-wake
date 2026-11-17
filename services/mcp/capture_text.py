"""Read previously unrecognized small text on locally uniform surfaces."""
import numpy as np
from PIL import Image, ImageOps


def candidate_lines(cv2, gray, labels):
    pixels = np.asarray(gray)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    strokes = np.where(cv2.blur(pixels, (15,15)) >= 128,
                       cv2.morphologyEx(pixels, cv2.MORPH_BLACKHAT, kernel),
                       cv2.morphologyEx(pixels, cv2.MORPH_TOPHAT, kernel)) > 11
    for group in labels:
        for l, t, r, b, _ in group:
            strokes[max(0,t-2):b+2, max(0,l-2):r+2] = False
    mask = strokes.astype(np.uint8)
    for shape in ((28,1),(1,48)):
        mask &= 1 - cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones(shape,np.uint8))
    connected = cv2.dilate(mask, np.ones((3, 11), np.uint8))
    _, _, stats, _ = cv2.connectedComponentsWithStats(connected)
    boxes = []
    for x,y,w,h,_ in stats[1:].tolist():
        if not (5 <= h <= 33 and 21 <= w <= 720 and w >= 1.45*h):
            continue
        ink = mask[y:y+h,x:x+w]
        if not 0.08 < ink.mean() < 0.60:
            continue
        l,t,r,b = max(0,x-3), max(0,y-4), min(gray.width,x+w+3), min(gray.height,y+h+4)
        crop = pixels[t:b,l:r]
        background = np.median(crop)
        if np.mean(abs(crop.astype(float)-background) < 8) < 0.63:
            continue
        boxes.append((l,t,r,b))
    # Limit the OCR cost on textured images, favoring text-sized lines.
    return sorted(sorted(boxes, key=lambda box: abs(box[3]-box[1]-22))[:80])


def read_batch(cv2, gray, boxes, labels, reader, threshold):
    # One OCR process for multiple isolated lines. Keep a white gutter so OCR
    # can segment neighboring crops without joining their words.
    placements = []
    y = 12
    width = max(r-l for l,t,r,b in boxes)*3 + 24
    sheet = Image.new("L", (width, sum((b-t)*3+24 for l,t,r,b in boxes)), 255)
    for l,t,r,b in boxes:
        crop = gray.crop((l,t,r,b))
        if np.median(np.asarray(crop)) < 128:
            crop = ImageOps.invert(crop)
        crop = crop.resize((crop.width*3,crop.height*3), Image.Resampling.LANCZOS)
        if threshold:
            pixels = np.asarray(crop)
            ink, background = np.percentile(pixels, (6, 60))
            # A narrow dark caret can otherwise set the threshold for an
            # entire line of pale gray text.
            cutoff = background - max(12, (background-ink)*0.45)
            _, binary = cv2.threshold(pixels, cutoff, 255, cv2.THRESH_BINARY)
            crop = Image.fromarray(binary)
        sheet.paste(crop, (12,y))
        placements.append((y,y+crop.height,(l,t,r,b)))
        y += crop.height+24
    recovered = set()
    for group in reader(sheet, min_confidence=65):
        for start,end,box in placements:
            l,t,r,b = box
            words = [(l+(x-12)//3,t+(y-start)//3,l+(rr-12+2)//3,t+(bb-start+2)//3,word)
                     for x,y,rr,bb,word in group
                     if start <= y < bb <= end and 12 <= x < rr <= 12+3*(r-l)]
            if not words or not any(sum(c.isalnum() for c in w[4]) >= 2 for w in words):
                continue
            fresh = []
            for token in words:
                x,y,rr,bb,_ = token
                if not any(a <= (x+rr)/2 < c and e <= (y+bb)/2 < d
                           for existing in labels for a,e,c,d,_ in existing):
                    fresh.append(token)
            if any(sum(c.isalnum() for c in token[4]) >= 2 for token in fresh):
                labels.append(fresh)
                recovered.add(box)
    return [box for box in boxes if box not in recovered]


def recover_small_text(image, labels, reader):
    try:
        import cv2
    except ModuleNotFoundError:
        return
    gray = image.convert("L")
    boxes = candidate_lines(cv2, gray, labels)
    for offset in range(0, len(boxes), 24):
        missing = read_batch(cv2, gray, boxes[offset:offset+24], labels, reader, False)
        if missing:
            read_batch(cv2, gray, missing, labels, reader, True)
