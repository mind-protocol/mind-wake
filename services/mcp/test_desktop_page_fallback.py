"""desktop_page text=true: empty/insignificant UIA text falls back to scrolling + OCR."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

HERE = Path(__file__).resolve().parent


def load():
    spec = importlib.util.spec_from_file_location("desktop_control_under_test", HERE / "desktop-control.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dc = load()

# Three distinct viewports then a repeat: the end of the page.
VIEWS = ["red", "green", "blue", "blue"]
LINES = {"red": ["Titre", "Post 1"], "green": ["Post 1", "Post 2"], "blue": ["Post 2", "Post 3 fin"]}


class Rect:
    left, top, right, bottom = 0, 100, 800, 700


class FakeDoc:
    def is_visible(self):
        return True

    def rectangle(self):
        return Rect()

    @property
    def iface_scroll(self):
        raise RuntimeError("no ScrollPattern")

    def set_focus(self):
        pass


class FakeRoot:
    def __init__(self, docs):
        self.docs = docs

    def descendants(self, control_type):
        return self.docs


class PageFallbackTests(unittest.TestCase):
    def run_page(self, uia, docs, covering=None):
        shots = iter(VIEWS)
        seen = []

        def capture(box):
            color = next(shots)
            seen.append(color)
            return Image.new("RGB", (64, 64), color)

        def ocr_lines(image):
            pixel = image.getpixel((32, 32))  # slices are saved as JPEG: pick the dominant channel
            name = ("red", "green", "blue")[pixel.index(max(pixel))]
            return LINES[name]

        keys, wheels = [], []
        with tempfile.TemporaryDirectory() as cache, \
                mock.patch.object(dc, "document_text", uia), \
                mock.patch.object(dc, "match", lambda items, target: {"id": "42"}), \
                mock.patch.object(dc, "windows", lambda: []), \
                mock.patch.object(dc, "focus", lambda hwnd: None), \
                mock.patch.object(dc, "check_focus", lambda hwnd: None), \
                mock.patch.object(dc, "bounds", lambda hwnd=None: (0, 0, 800, 800)), \
                mock.patch.object(dc, "window_ui", lambda hwnd: FakeRoot(docs)), \
                mock.patch.object(dc, "render_widget", lambda hwnd: 7), \
                mock.patch.object(dc.gui, "GetWindowRect", lambda h: (0, 120, 800, 720)), \
                mock.patch.object(dc.gui, "GetWindowText", lambda h: "LinkedIn - Chrome"), \
                mock.patch.object(dc, "move_pointer", lambda x, y: None), \
                mock.patch.object(dc.gui, "WindowFromPoint", lambda p: covering or 42), \
                mock.patch.object(dc.gui, "GetAncestor", lambda h, flag: h), \
                mock.patch.object(dc, "capture", capture), \
                mock.patch.object(dc, "ocr_lines", ocr_lines), \
                mock.patch.object(dc, "render", lambda im, x, y, a: {}), \
                mock.patch.object(dc.time, "sleep", lambda s: None), \
                mock.patch.object(dc.mouse, "hotkey", lambda *k: keys.append(k)), \
                mock.patch.object(dc.mouse, "press", lambda k: keys.append(k)), \
                mock.patch.object(dc.mouse, "scroll", lambda n, *xy: wheels.append(n)):
            result = dc.run("desktop_page", {"window": "LinkedIn", "text": True, "max_slices": 12,
                                             "mode": "ascii", "columns": 160, "simplified": True}, Path(cache))
        return result, keys, wheels

    def test_empty_uia_falls_back_to_ocr_full_text(self):
        result, keys, _ = self.run_page(lambda hwnd: "", [FakeDoc()])
        self.assertEqual(result["source"], "ocr_stitched_slices")
        self.assertEqual(result["text"], "Titre\nPost 1\nPost 2\nPost 3 fin")
        self.assertEqual(result["slices"], 3)
        self.assertFalse(result["limit_reached"])
        self.assertIn("pagedown", keys)

    def test_insignificant_or_failing_uia_falls_back(self):
        for uia in (lambda hwnd: None, lambda hwnd: " ￼ LinkedIn ￼ ",
                    mock.Mock(side_effect=RuntimeError("COM"))):
            result, _, _ = self.run_page(uia, [FakeDoc()])
            self.assertEqual(result["source"], "ocr_stitched_slices")

    def test_no_uia_document_scrolls_web_content_with_wheel(self):
        result, keys, wheels = self.run_page(lambda hwnd: "", [])
        self.assertEqual(result["text"], "Titre\nPost 1\nPost 2\nPost 3 fin")
        self.assertNotIn("pagedown", keys)
        self.assertTrue(any(n < 0 for n in wheels) and any(n > 0 for n in wheels))

    def test_wheel_never_scrolls_a_window_covering_the_page(self):
        # e.g. the MIND app over LinkedIn: no wheel event is sent at all.
        with self.assertRaises(ValueError) as ctx:
            self.run_page(lambda hwnd: "", [], covering=99)
        self.assertIn("recouverte", str(ctx.exception))

    def test_significant_uia_text_is_returned_directly(self):
        text = " ".join(f"mot{i}" for i in range(40))
        with mock.patch.object(dc, "document_text", lambda hwnd: text), \
                mock.patch.object(dc, "match", lambda items, target: {"id": "42"}), \
                mock.patch.object(dc, "windows", lambda: []), \
                mock.patch.object(dc.gui, "GetWindowText", lambda h: "Page"):
            result = dc.run("desktop_page", {"window": "Page", "text": True}, Path("."))
        self.assertEqual(result["source"], "uia_text_pattern")
        self.assertEqual(result["text"], text)


if __name__ == "__main__":
    unittest.main()
