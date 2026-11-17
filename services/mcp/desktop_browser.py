"""Browser launch inputs for an already-authorized room desktop request."""
import os
from pathlib import Path
from urllib.parse import urlsplit


def validate_url(value):
    if not isinstance(value, str) or any(ord(char) < 32 for char in value):
        raise ValueError("HTTP(S) URL required.")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("HTTP(S) URL without credentials required.")
    return value


def profile_path(root, room):
    if not root or not Path(root).is_absolute() or not isinstance(room, int) or isinstance(room, bool) or room < 1:
        raise ValueError("Host browser root and room required.")
    return Path(root).resolve() / f"room-{room}"


def chrome_executable():
    # MCP/CLI environments may omit ProgramFiles even on a normal Windows installation.
    drive = os.environ.get("SystemDrive", "C:")
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                 str(Path(drive + "/") / "Program Files"), str(Path(drive + "/") / "Program Files (x86)"),
                 os.environ.get("LOCALAPPDATA")):
        if base:
            candidate = Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"
            if candidate.is_file():
                return candidate
    raise ValueError("Installed Chrome executable not found; no default-profile fallback.")
