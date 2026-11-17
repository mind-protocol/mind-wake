"""OCR must work when the MCP server runs with a reduced environment (no ProgramFiles)."""
import importlib.util
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent


def load():
    spec = importlib.util.spec_from_file_location("desktop_control_ocr_env", HERE / "desktop-control.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dc = load()
REDUCED = {k: v for k, v in os.environ.items()
           if k.upper() not in ("PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PATH")}


class TesseractPathTests(unittest.TestCase):
    def test_no_keyerror_without_programfiles(self):
        with mock.patch.dict(os.environ, REDUCED, clear=True), \
                mock.patch.object(dc.shutil, "which", lambda name: None), \
                mock.patch.object(dc.os.path, "isfile",
                                  lambda p: p == r"C:\Program Files\Tesseract-OCR\tesseract.exe"):
            self.assertEqual(dc.tesseract_path(), r"C:\Program Files\Tesseract-OCR\tesseract.exe")

    def test_missing_binary_gives_explicit_error(self):
        with mock.patch.dict(os.environ, REDUCED, clear=True), \
                mock.patch.object(dc.shutil, "which", lambda name: None), \
                mock.patch.object(dc.os.path, "isfile", lambda p: False):
            with self.assertRaises(FileNotFoundError):
                dc.tesseract_path()

    def test_path_hit_wins(self):
        with mock.patch.object(dc.shutil, "which", lambda name: r"D:\tools\tesseract.exe"):
            self.assertEqual(dc.tesseract_path(), r"D:\tools\tesseract.exe")

    def test_real_ocr_in_subprocess_without_programfiles(self):
        """End to end: a child Python with ProgramFiles and PATH stripped runs dc.ocr."""
        if not Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe").is_file():
            self.skipTest("Tesseract not installed at the default location")
        env = dict(REDUCED)
        env["SystemRoot"] = os.environ.get("SystemRoot", r"C:\Windows")
        code = (
            "import importlib.util, os, sys\n"
            "assert 'ProgramFiles' not in os.environ\n"
            "from PIL import Image, ImageDraw\n"
            f"spec = importlib.util.spec_from_file_location('dc', r'{HERE / 'desktop-control.py'}')\n"
            "dc = importlib.util.module_from_spec(spec); spec.loader.exec_module(dc)\n"
            "im = Image.new('RGB', (420, 80), 'white')\n"
            "ImageDraw.Draw(im).text((10, 25), 'HELLO OCR', fill='black', font_size=36)\n"
            "print(dc.tesseract_path())\n"
            "dc.ocr(im, 0, 0)\n"
            "print('ok')\n"
        )
        proc = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True,
                              text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("ok", proc.stdout)


if __name__ == "__main__":
    unittest.main()
