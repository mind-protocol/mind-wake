"""Low-contrast surfaces and reverse-polarity labels in desktop screenshots."""
import numpy as np
from PIL import Image, ImageOps


def detect_surfaces(image):
    try:
        import cv2
    except ModuleNotFoundError:
        return [], []
    gray = image.convert("L")
    scale = min(1, 1920 / max(gray.size))
    size = tuple(max(1, round(n * scale)) for n in gray.size)
    pixels = np.asarray(gray.resize(size, Image.Resampling.BILINEAR))
    edges = cv2.Canny(cv2.GaussianBlur(pixels, (5, 5), 1), 8, 24)
    contours, hierarchy = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    panels, stops = [], set()
    for i, contour in enumerate(contours):
        x, y, w, h = cv2.boundingRect(contour)
        if min(w, h) < 10 or w*h < 120:
            continue
        area = cv2.contourArea(contour)
        fill = area / (w * h)
        box = tuple(round(n / scale) for n in (x, y, x+w, y+h))
        if w >= 90*scale and h >= 23*scale:
            if fill >= 0.91 or open_panel(pixels, x, y, w, h, fill):
                panels.append(box)
        elif 0.9 < w/h < 1.11 and max(w,h) < 74*scale and 0.69 < fill < 0.83:
            perimeter = cv2.arcLength(contour, True)
            if 4*np.pi*area / max(1, perimeter**2) < 0.83:
                continue
            # Canny generally produces two nested contours per painted edge.
            child = hierarchy[0, i, 2]
            while child >= 0:
                inner = contours[child]
                l, t, iw, ih = cv2.boundingRect(inner)
                if iw < w*0.66:
                    if (iw >= w*0.25 and abs(iw-ih) <= max(1, iw*0.12)
                            and abs(l+iw/2-x-w/2) <= 1.5 and abs(t+ih/2-y-h/2) <= 1.5):
                        poly = cv2.approxPolyDP(inner, cv2.arcLength(inner, True)*0.045, True)
                        if len(poly) == 4:
                            corners = poly.reshape(-1,2)
                            # Corners near the bbox corners distinguish an upright
                            # square from a circle approximated as a diamond.
                            if (all(min(abs(u-l),abs(u-l-iw+1)) <= iw*0.20 and
                                    min(abs(v-t),abs(v-t-ih+1)) <= ih*0.20 for u,v in corners)
                                    and solid_disk(pixels[y:y+h,x:x+w])):
                                stops.add(box)
                    break
                child = hierarchy[0, child, 2]
    # Inner/outer contours and shadow edges often describe the same surface.
    distinct = []
    for box in sorted(set(panels)):
        if not any(all(abs(a-b) <= 6/scale for a,b in zip(box, other)) for other in distinct):
            distinct.append(box)
    return distinct, sorted(stops)


def open_panel(pixels, x, y, w, h, fill):
    # A faded side or scrollbar can leave a surface with an open contour.
    # Require the same flat interior and a distinct exterior on three sides.
    if fill > 0.015 or w < 140 or h < 60 or min(x,y) < 6 or x+w+6 >= pixels.shape[1] or y+h+6 >= pixels.shape[0]:
        return False
    crop = pixels[y:y+h,x:x+w]
    tone = np.median(crop[::4,::4])
    if np.mean(np.abs(crop[::4,::4]-tone) <= 3) < 0.75:
        return False
    mids_x = slice(x+w//6,x+5*w//6)
    mids_y = slice(y+h//6,y+5*h//6)
    pairs = ((pixels[y+6,mids_x], pixels[y-6,mids_x]),
             (pixels[y+h-7,mids_x], pixels[y+h+5,mids_x]),
             (pixels[mids_y,x+6], pixels[mids_y,x-6]),
             (pixels[mids_y,x+w-7], pixels[mids_y,x+w+5]))
    return sum(np.mean((np.abs(inner-tone) < 8) & (np.abs(outer-tone) >= 8)) > 0.7
               for inner,outer in pairs) >= 3


def solid_disk(tile):
    h,w = tile.shape
    y,x = np.ogrid[:h,:w]
    radius = ((x+0.5-w/2)/(w/2))**2 + ((y+0.5-h/2)/(h/2))**2
    ring = tile[(radius >= 0.40) & (radius < 0.64)]
    corners = tile[radius > 1.25]
    if not ring.size or not corners.size:
        return False
    tone = np.median(ring)
    inner_contrast = abs(np.median(tile[radius < 0.04])-tone)
    if (np.mean(np.abs(ring-tone) < 26) <= 0.82
            or abs(np.median(corners)-tone) < 45 or inner_contrast < 45):
        return False
    center = (radius < 0.38) & (np.abs(tile-tone) > inner_contrast*0.55)
    ys,xs = np.where(center)
    if not xs.size:
        return False
    return center.sum() >= 0.89 * (int(xs.max()-xs.min())+1) * (int(ys.max()-ys.min())+1)


def recover_dark_labels(image, panels, labels, read_labels):
    dark = []
    for left, top, right, bottom in panels:
        if right-left < 100 or bottom-top > 250:
            continue
        if any(left < (x+r)/2 < right and top < (y+b)/2 < bottom
               for group in labels for x,y,r,b,_ in group):
            continue
        inset = min(8, (bottom-top)//5)
        crop = image.crop((left+inset, top+inset, right-inset, bottom-inset)).convert("L")
        pixels = np.asarray(crop)
        if np.median(pixels) < 90 and np.mean(pixels > 140) > 0.012:
            dark.append((crop, left+inset, top+inset))
    # Pack candidate panels into one OCR request; coordinates stay local.
    batch = []
    width = height = 0
    for panel in dark:
        im = panel[0]
        new_width = max(width, im.width*2+32)
        new_height = height+im.height*2+32
        if batch and new_width*new_height > 4_000_000:
            read_panel_batch(batch, labels, read_labels)
            batch = []
            new_width, new_height = im.width*2+32, im.height*2+32
        batch.append(panel)
        width, height = new_width, new_height
    if batch:
        read_panel_batch(batch, labels, read_labels)


def read_panel_batch(dark, labels, read_labels):
    width = max(im.width for im,_,_ in dark)*2+32
    height = sum(im.height*2+32 for im,_,_ in dark)
    sheet = Image.new("L", (width,height), 255)
    offsets = []
    cursor = 0
    for im, x, y in dark:
        inverted = ImageOps.invert(im).resize((im.width*2, im.height*2), Image.Resampling.BICUBIC)
        sheet.paste(inverted, (16,cursor+16))
        offsets.append((cursor+16, cursor+16+inverted.height, x, y))
        cursor += inverted.height+32
    for group in read_labels(sheet):
        for offset, end, x, y in offsets:
            words = [(x+(l-16)//2, y+(t-offset)//2, x+(r-15)//2, y+(b-offset+1)//2, word)
                     for l,t,r,b,word in group if offset <= (t+b)/2 < end]
            if words:
                labels.append(words)


def draw_panels(chars, panels, size, columns, rows):
    sx, sy = columns/size[0], rows/size[1]
    for l,t,r,b in panels:
        left, right = int(l*sx), min(columns-1, int((r-1)*sx))
        top, bottom = int(t*sy), min(rows-1, int((b-1)*sy))
        if right-left < 5 or bottom-top < 1:
            continue
        for y in (top,bottom):
            for x in range(left+1,right):
                if chars[y*columns+x] == " ":
                    chars[y*columns+x] = "─"
        for y in range(top+1,bottom):
            for x in (left,right):
                if chars[y*columns+x] == " ":
                    chars[y*columns+x] = "│"
        for y,x,mark in ((top,left,"┌"),(top,right,"┐"),(bottom,left,"└"),(bottom,right,"┘")):
            if chars[y*columns+x] in " ─│┼":
                chars[y*columns+x] = mark
