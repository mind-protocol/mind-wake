"""Unit tests for desktop_text (no real keyboard, clipboard or UI Automation)."""
import unittest
from unittest import mock

import desktop_text as T


class FakeClipboard:
    """win32clipboard stand-in: formats dict, open/close accounting."""
    CF_UNICODETEXT = 13

    def __init__(self, formats):
        self.formats = dict(formats)
        self.opened = 0
        self.registered = {}

    def OpenClipboard(self):
        assert self.opened == 0, "clipboard opened twice"
        self.opened += 1

    def CloseClipboard(self):
        self.opened -= 1

    def EnumClipboardFormats(self, fmt):
        keys = list(self.formats)
        if fmt == 0:
            return keys[0] if keys else 0
        i = keys.index(fmt) + 1
        return keys[i] if i < len(keys) else 0

    def GetClipboardData(self, fmt):
        if fmt == 0xC0FF:
            raise TypeError("delayed rendering refused")
        return self.formats[fmt]

    def EmptyClipboard(self):
        self.formats.clear()

    def SetClipboardData(self, fmt, data):
        self.formats[fmt] = data

    def RegisterClipboardFormat(self, name):
        return self.registered.setdefault(name, 0xC100 + len(self.registered))


class Verdict(unittest.TestCase):
    def test_present_after_insert(self):
        self.assertTrue(T.check_inserted("", "Bonjour Mme Lefèvre", "Bonjour Mme Lefèvre"))
        self.assertTrue(T.check_inserted("Objet : ", "Objet : merci", "merci"))

    def test_missing_characters(self):
        self.assertFalse(T.check_inserted("", "Bonjour Mme Lefvre", "Bonjour Mme Lefèvre"))

    def test_unreadable_field(self):
        self.assertIsNone(T.check_inserted(None, None, "texte"))

    def test_already_present_before_is_not_an_insertion(self):
        self.assertFalse(T.check_inserted("merci", "merci", "merci"))
        self.assertTrue(T.check_inserted("merci", "merci merci", "merci"))

    def test_normalization(self):
        self.assertTrue(T.check_inserted("", "ligne 1\r\nligne 2 \n", "ligne 1\nligne 2"))

    def test_describe(self):
        self.assertEqual(T.describe("", "Bonjr", "Bonjour"),
                         "5 caractères ajoutés sur 7 attendus, première divergence au caractère 5")
        self.assertEqual(T.describe("Objet:", "Objet:mrci", "merci"),
                         "4 caractères ajoutés sur 5 attendus, première divergence au caractère 2")
        self.assertEqual(T.describe(None, None, "x"), "champ illisible par UI Automation")


class Clipboard(unittest.TestCase):
    def test_save_put_restore_roundtrip(self):
        original = {13: "presse-papiers de NLR", 49161: b"<html>riche</html>", 2: 1234, 0xC0FF: b"x"}
        cb = FakeClipboard(original)
        saved = T.save_clipboard(cb)
        # GDI handle (CF_BITMAP) and refused delayed formats are skipped, the rest kept in order.
        self.assertEqual(saved, [(13, "presse-papiers de NLR"), (49161, b"<html>riche</html>")])
        T.put_text(cb, "texte à coller")
        self.assertEqual(cb.formats[13], "texte à coller")
        self.assertIn("ExcludeClipboardContentFromMonitorProcessing", cb.registered)
        self.assertIn("CanIncludeInClipboardHistory", cb.registered)
        T.restore_clipboard(cb, saved)
        self.assertEqual(cb.formats, {13: "presse-papiers de NLR", 49161: b"<html>riche</html>"})
        self.assertEqual(cb.opened, 0)

    def test_paste_restores_clipboard_even_on_failure(self):
        cb = FakeClipboard({13: "à garder"})

        def boom():
            raise ValueError("La fenêtre cible a perdu le focus.")

        with mock.patch.object(T, "focused_text", return_value=""):
            with self.assertRaises(ValueError):
                T.paste("nouveau texte", boom, lambda: None, 1, "", cb)
        self.assertEqual(cb.formats, {13: "à garder"})

    def test_paste_waits_for_field_before_restoring(self):
        cb = FakeClipboard({13: "à garder"})
        field = {"value": ""}
        seen = []

        def press():
            seen.append(cb.formats.get(13))
            field["value"] = cb.formats[13]

        with mock.patch.object(T, "focused_text", side_effect=lambda h: field["value"]):
            verdict, after = T.paste("Bonjour", lambda: None, press, 1, "", cb)
        self.assertEqual(seen, ["Bonjour"])
        self.assertTrue(verdict)
        self.assertEqual(cb.formats, {13: "à garder"})


class Insert(unittest.TestCase):
    def setUp(self):
        self.field = {"value": ""}
        self.typed = []
        patches = [
            mock.patch.object(T, "focused_text", side_effect=lambda h: self.field["value"]),
            mock.patch.object(T, "send", side_effect=self.fake_send),
            mock.patch.object(T, "KEY_DELAY", 0),
            mock.patch.object(T, "SETTLE_SECONDS", 0.05),
            mock.patch("time.sleep"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def fake_send(self, events):
        chars = bytes(b for e in events if e.payload.keyboard.flags == 4
                      for b in e.payload.keyboard.scan.to_bytes(2, "little")).decode("utf-16-le")
        self.typed.append(chars)
        self.field["value"] += chars

    def test_short_text_is_typed_one_char_per_input(self):
        report = T.insert_text("ok", 1, lambda: None, lambda: None)
        self.assertEqual(self.typed, ["o", "k"])
        self.assertEqual(report, dict(chars=2, method="keys", verified=True))

    def test_surrogate_pair_stays_in_one_input(self):
        T.insert_text("a🙂", 1, lambda: None, lambda: None, method="keys")
        self.assertEqual(self.typed, ["a", "🙂"])

    def test_long_text_is_pasted(self):
        def press():
            self.field["value"] += "Bonjour Mme Lefèvre"

        with mock.patch.object(T, "save_clipboard", return_value=[]), \
                mock.patch.object(T, "put_text"), mock.patch.object(T, "restore_clipboard"):
            report = T.insert_text("Bonjour Mme Lefèvre", 1, lambda: None, press)
        self.assertEqual(report, dict(chars=19, method="paste", verified=True))
        self.assertEqual(self.typed, [])

    def test_paste_without_effect_falls_back_to_keys(self):
        with mock.patch.object(T, "save_clipboard", return_value=[]), \
                mock.patch.object(T, "put_text"), mock.patch.object(T, "restore_clipboard"):
            report = T.insert_text("Bonjour", 1, lambda: None, lambda: None)
        self.assertEqual(report["method"], "keys")
        self.assertEqual(report["fallback"], "keys")
        self.assertTrue(report["verified"])
        self.assertEqual(self.field["value"], "Bonjour")

    def test_partial_paste_is_reported_not_retyped(self):
        def press():
            self.field["value"] += "Bonjou"

        with mock.patch.object(T, "save_clipboard", return_value=[]), \
                mock.patch.object(T, "put_text"), mock.patch.object(T, "restore_clipboard"):
            report = T.insert_text("Bonjour", 1, lambda: None, press)
        self.assertEqual(report["method"], "paste")
        self.assertFalse(report["verified"])
        self.assertIn("6 caractères ajoutés sur 7", report["detail"])
        self.assertEqual(self.typed, [])

    def test_unknown_method(self):
        with self.assertRaises(ValueError):
            T.insert_text("x", 1, lambda: None, lambda: None, method="magic")


if __name__ == "__main__":
    unittest.main()
