"""Real-wheel scrolling: notch size, measured displacement and fallbacks (no real input sent)."""
import importlib.util
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

import desktop_wheel as dw

HERE = Path(__file__).resolve().parent


def page(height=4000, width=300, seed=7):
    rng = np.random.default_rng(seed)
    rows = rng.integers(0, 255, size=(height, 1), dtype=np.uint8)
    noise = rng.integers(0, 255, size=(height, width), dtype=np.uint8)
    # Text-like stripes with blank gaps, like a feed.
    content = np.where(((np.arange(height) // 9) % 3 == 0)[:, None], 255, ((rows.astype(int) + noise // 4) % 256).astype(np.uint8))
    return content.astype(np.uint8)


class FakeScroller:
    """A 600 px viewport over a long page; wheel data scrolls proportionally like Chrome/Qt."""

    def __init__(self, px_per_notch=100, header=40, ignore_partial=False, scrollable=True):
        self.doc = page()
        self.top = 1000
        self.px_per_notch = px_per_notch
        self.header = header
        self.ignore_partial = ignore_partial
        self.scrollable = scrollable
        self.sent = []

    def wheel(self, delta):
        self.sent.append(delta)
        if not self.scrollable or (self.ignore_partial and abs(delta) < dw.WHEEL_DELTA):
            return
        self.top -= round(delta / dw.WHEEL_DELTA * self.px_per_notch)
        self.top = max(0, min(len(self.doc) - 600, self.top))

    def key(self, name):
        self.top += 500 if name == "pagedown" else -500
        self.top = max(0, min(len(self.doc) - 600, self.top))

    def grab(self):
        view = self.doc[self.top:self.top + 600].copy()
        view[:self.header] = 30  # fixed toolbar, never scrolls
        return Image.fromarray(view, "L").convert("RGB")


def patched(scroller):
    return mock.patch.multiple(dw, send_wheel=scroller.wheel, guard=lambda hwnd, point: None,
                               settle=lambda grab, **_: grab())


class ShiftTests(unittest.TestCase):
    def test_measures_shift_both_ways_with_fixed_header(self):
        s = FakeScroller()
        before = s.grab()
        s.top += 137
        self.assertEqual(dw.vertical_shift(before, s.grab()), 137)
        before = s.grab()
        s.top -= 60
        self.assertEqual(dw.vertical_shift(before, s.grab()), -60)

    def test_unchanged_is_zero_and_replaced_view_is_none(self):
        s = FakeScroller()
        self.assertEqual(dw.vertical_shift(s.grab(), s.grab()), 0)
        before = s.grab()
        s.top += 2000
        self.assertIsNone(dw.vertical_shift(before, s.grab()))


class WheelTests(unittest.TestCase):
    def test_ticks_are_whole_notches_and_movement_is_reported(self):
        s = FakeScroller(px_per_notch=100)
        with patched(s):
            report = dw.wheel_ticks(1, (0, 0), -5, s.grab)
        # The old path sent mouse_event(dwData=-5): 1/24 of a notch.
        self.assertTrue(all(d == -dw.WHEEL_DELTA for d in s.sent))
        self.assertEqual(sum(s.sent), -5 * dw.WHEEL_DELTA)
        self.assertEqual(report["moved"], 500)
        self.assertEqual(report["pixels_per_tick"], 100)

    def test_ticks_stop_at_the_end_of_the_list(self):
        s = FakeScroller(px_per_notch=100)
        s.top = len(s.doc) - 600 - 150
        with patched(s):
            report = dw.wheel_ticks(1, (0, 0), -100, s.grab)
        self.assertEqual(report["moved"], 150)
        self.assertEqual(report["stopped"], "no_movement")
        self.assertLess(report["ticks_sent"], 100)

    def test_pixels_calibrate_then_land_on_target(self):
        s = FakeScroller(px_per_notch=53)
        with patched(s):
            report = dw.wheel_pixels(1, (0, 0), 400, s.grab)
        self.assertEqual(report["method"], "wheel")
        self.assertLessEqual(abs(report["moved"] - 400), 6)
        self.assertEqual(report["moved"], s.top - 1000)

    def test_pixels_up(self):
        s = FakeScroller(px_per_notch=120)
        with patched(s):
            report = dw.wheel_pixels(1, (0, 0), -250, s.grab)
        self.assertLessEqual(abs(report["moved"] + 250), 6)

    def test_keyboard_fallback_when_wheel_moves_nothing(self):
        s = FakeScroller(scrollable=False)
        with patched(s):
            report = dw.scroll_any(1, (0, 0), 900, s.grab, s.key)
        self.assertEqual(report["method"], "keys")
        self.assertEqual(report["fallback"], "wheel_no_movement")
        self.assertEqual(report["moved"], 1000)


def load_control():
    spec = importlib.util.spec_from_file_location("desktop_control_wheel", HERE / "desktop-control.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ActWiringTests(unittest.TestCase):
    def test_pixels_without_uia_container_fall_back_to_wheel(self):
        import desktop_scroll
        dc = load_control()
        s = FakeScroller(px_per_notch=100)

        def no_container(*_):
            raise desktop_scroll.NoScrollContainer("Aucun conteneur défilable accessible à cette position.")
        with patched(s), mock.patch.object(desktop_scroll, "scroll_pixels", no_container), \
                mock.patch.object(dc, "bounds", lambda hwnd: (0, 0, 300, 600)), \
                mock.patch.object(dc, "capture", lambda box: s.grab()):
            report = dc.scroll_at(1, 10, 10, {"op": "scroll", "pixels": 400})
        self.assertEqual(report["method"], "wheel")
        self.assertLessEqual(abs(report["moved"] - 400), 6)

    def test_ticks_go_through_real_notches(self):
        dc = load_control()
        s = FakeScroller(px_per_notch=100)
        with patched(s), mock.patch.object(dc, "bounds", lambda hwnd: (0, 0, 300, 600)), \
                mock.patch.object(dc, "capture", lambda box: s.grab()):
            report = dc.scroll_at(1, 10, 10, {"op": "scroll", "ticks": -3})
        self.assertEqual(report["moved"], 300)


if __name__ == "__main__":
    unittest.main()
