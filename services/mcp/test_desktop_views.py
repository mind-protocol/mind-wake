"""Reads never switch the visible desktop; a desktop_list window ID is found on any desktop."""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("desktop_control_views", HERE / "desktop-control.py")
dc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dc)


class Desk:
    def __init__(self, guid):
        self.id = guid


D1, D2, ROOM = Desk("g1"), Desk("g2"), Desk("g-room")
DESKS = [D1, D2, ROOM]


def fake_room_desktop(visible, window_desktops):
    state = types.SimpleNamespace(visible=visible, switches=[])
    module = types.ModuleType("room_desktop")
    module.resolve = lambda db, room: ROOM
    module.by_number = lambda n: DESKS[n - 1]

    def switch(desktop):  # like room_desktop.switch: no-op on the visible desktop
        if state.visible.id == desktop.id:
            return
        state.switches.append(desktop.id)
        state.visible = desktop
    module.switch = switch
    module.number_of = lambda hwnd: window_desktops.get(hwnd)
    module.owns = lambda desktop, hwnd: True
    module.VirtualDesktop = types.SimpleNamespace(current=lambda: state.visible)
    return module, state


class DesktopViewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"MIND_WAKE_DATA_DIR": self.tmp.name})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def dispatch(self, tool, args, visible, window_desktops=None, desktop=None):
        module, state = fake_room_desktop(visible, window_desktops or {})
        seen = {}

        def run(t, a, cache, restore=None):
            seen.update(target=dc.target_desktop, desktop=dc.room_desktop, visible=state.visible)
            return {}
        req = dict(tool=tool, args=args, cache=self.tmp.name, room=2, owner={"id": "o", "name": "Room 2"})
        if desktop is not None:
            req["desktop"] = desktop
        with mock.patch.dict(sys.modules, {"room_desktop": module}), \
                mock.patch.object(dc, "run", run), \
                mock.patch.object(dc.gui, "IsWindow", lambda h: True):
            dc.dispatch(req)
        return seen, state

    def test_window_id_from_desktop_list_is_found_on_desktop_1(self):
        seen, state = self.dispatch("desktop_observe", {"window": "132052"}, visible=D1,
                                    window_desktops={132052: 1})
        self.assertEqual(seen["target"], 1)
        self.assertIs(seen["desktop"], D1)
        self.assertEqual(state.switches, [])

    def test_title_stays_on_room_desktop_by_default(self):
        seen, _ = self.dispatch("desktop_observe", {"window": "LinkedIn"}, visible=D1)
        self.assertIsNone(seen["target"])
        self.assertIs(seen["desktop"], ROOM)

    def test_whole_screen_and_taskbar_reads_never_switch(self):
        for tool, args in (("desktop_observe", {}), ("desktop_ascii", {}), ("desktop_taskbar", {})):
            seen, state = self.dispatch(tool, args, visible=D1)
            self.assertEqual(state.switches, [], tool)
            self.assertIs(seen["visible"], D1)

    def test_input_on_visible_desktop_1_by_window_id_does_not_switch(self):
        _, state = self.dispatch("desktop_act", {"window": "132052", "actions": []}, visible=D1,
                                 window_desktops={132052: 1})
        self.assertEqual(state.switches, [])

    def test_input_on_hidden_room_desktop_switches_and_returns(self):
        _, state = self.dispatch("desktop_act", {"window": "Notepad", "actions": []}, visible=D1)
        self.assertEqual(state.switches, ["g-room", "g1"])

    def test_hidden_desktop_screen_is_composited_without_screen_grab(self):
        module, _ = fake_room_desktop(D1, {})
        painted = []

        def read(hwnd, box):
            painted.append(hwnd)
            return Image.new("RGB", (box[2] - box[0], box[3] - box[1]), (200, 0, 0) if hwnd == 1 else (0, 0, 200))
        rects = {1: (0, 0, 100, 100), 2: (50, 50, 150, 150)}
        with mock.patch.dict(sys.modules, {"room_desktop": module}), \
                mock.patch.object(dc, "room_desktop", ROOM), \
                mock.patch.object(dc, "desktop_windows_bottom_up", lambda d: [1, 2]), \
                mock.patch.object(dc.gui, "GetWindowRect", lambda h: rects[h]), \
                mock.patch.object(dc, "read_window", read), \
                mock.patch.object(dc, "capture", mock.Mock(side_effect=AssertionError("screen grab"))):
            image = dc.composite_desktop((0, 0, 200, 200))
        self.assertEqual(painted, [1, 2])
        self.assertEqual(image.getpixel((10, 10)), (200, 0, 0))
        self.assertEqual(image.getpixel((60, 60)), (0, 0, 200))  # upper window painted last
        self.assertEqual(image.getpixel((190, 190)), (32, 32, 32))

    def test_read_window_uses_composite_when_room_desktop_hidden(self):
        with mock.patch.object(dc, "room_desktop", ROOM), \
                mock.patch.object(dc, "current_desktop_id", lambda: "g1"), \
                mock.patch.object(dc, "composite_desktop", lambda box: "composite"), \
                mock.patch.object(dc, "capture", mock.Mock(side_effect=AssertionError("screen grab"))):
            self.assertEqual(dc.read_window(None, (0, 0, 10, 10)), "composite")


if __name__ == "__main__":
    unittest.main()
