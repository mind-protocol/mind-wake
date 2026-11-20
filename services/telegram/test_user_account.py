"""Compte Telegram personnel : fonctions pures du sidecar (aucune connexion, aucune session)."""
import sqlite3
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_account as ua  # noqa: E402


class SafeFileNameTest(unittest.TestCase):
    def test_no_path_and_message_prefix(self):
        self.assertEqual(ua.safe_file_name("../../evil/run.bat", 12, ".bat"), "12-run.bat")
        self.assertEqual(ua.safe_file_name("C:\\Windows\\x.exe", 3, ".exe"), "3-x.exe")

    def test_reserved_characters_replaced(self):
        self.assertEqual(ua.safe_file_name('a<b>:"c|?*.pdf', 5, ".pdf"), "5-a_b_c_.pdf")

    def test_empty_name_uses_extension(self):
        self.assertEqual(ua.safe_file_name(None, 7, ".pdf"), "7-document.pdf")
        self.assertEqual(ua.safe_file_name("...", 7, None), "7-document")

    def test_long_name_capped(self):
        self.assertLessEqual(len(ua.safe_file_name("x" * 500 + ".pdf", 1, ".pdf")), 2 + 120)


class DialogTypeTest(unittest.TestCase):
    def test_types(self):
        self.assertEqual(ua.dialog_type(SimpleNamespace(is_user=True, is_channel=False, is_group=False)), "private")
        self.assertEqual(ua.dialog_type(SimpleNamespace(is_user=False, is_channel=True, is_group=False)), "channel")
        self.assertEqual(ua.dialog_type(SimpleNamespace(is_user=False, is_channel=True, is_group=True)), "group")
        self.assertEqual(ua.dialog_type(SimpleNamespace(is_user=False, is_channel=False, is_group=True)), "group")


class LockedTest(unittest.TestCase):
    def test_only_sqlite_lock(self):
        self.assertTrue(ua.is_locked(sqlite3.OperationalError("database is locked")))
        self.assertFalse(ua.is_locked(sqlite3.OperationalError("no such table")))
        self.assertFalse(ua.is_locked(RuntimeError("database is locked")))


if __name__ == "__main__":
    unittest.main()
