"""Windows virtual desktops used by the room-scoped desktop MCP worker."""
import time

from comtypes import COMError
from pyvda import AppView, VirtualDesktop, get_virtual_desktops


def resolve(db, room):
    db.execute("CREATE TABLE IF NOT EXISTS room_desktop (room INTEGER PRIMARY KEY, guid TEXT NOT NULL)")
    # Concurrent first observations must agree on one desktop.
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT guid FROM room_desktop WHERE room=?", (room,)).fetchone()
        desktops = get_virtual_desktops()
        desktop = next((item for item in desktops if row and str(item.id) == row[0]), None)
        if desktop is None:
            desktop = VirtualDesktop.create()
            db.execute("INSERT OR REPLACE INTO room_desktop VALUES (?,?)", (room, str(desktop.id)))
            db.commit()
            desktop.rename(f"MindWake · Room {room}")
        else:
            db.commit()
        return desktop
    except BaseException:
        db.rollback()
        raise


def owns(desktop, hwnd):
    try:
        return AppView(hwnd=hwnd).desktop_id == desktop.id
    except (COMError, OSError, ValueError):
        return False


def switch(desktop):
    if VirtualDesktop.current().id == desktop.id:
        return
    desktop.go()
    until = time.monotonic() + 3
    while VirtualDesktop.current().id != desktop.id:
        if time.monotonic() >= until:
            raise RuntimeError("Windows n'a pas activé le bureau demandé.")
        time.sleep(.025)
    # The compositor can still be sliding the previous desktop out of view.
    time.sleep(.35)
    if VirtualDesktop.current().id != desktop.id:
        raise RuntimeError("Le bureau a changé pendant la transition.")


def by_number(number):
    """Windows virtual desktop by its 1-based Win+Tab position."""
    desktops = get_virtual_desktops()
    if not 1 <= number <= len(desktops):
        raise ValueError(f"Bureau virtuel {number} inexistant : {len(desktops)} bureau(x) Windows. Voir desktop_list.")
    return desktops[number - 1]


def number_of(hwnd):
    """1-based Win+Tab number of the virtual desktop holding a window, or None."""
    if not hwnd:
        return None
    try:
        guid = AppView(hwnd=hwnd).desktop_id
    except (COMError, OSError, ValueError):
        return None
    for index, desktop in enumerate(get_virtual_desktops()):
        if desktop.id == guid:
            return index + 1
    return None


def inventory(own, list_windows):
    """Every virtual desktop with the visible windows that Windows assigns to it."""
    current = VirtualDesktop.current().id
    desktops = get_virtual_desktops()
    by_id = {str(d.id): dict(desktop=d.number, name=d.name, id=str(d.id), visible=d.id == current,
                             this_room=own is not None and d.id == own.id, windows=[]) for d in desktops}
    for hwnd, title in list_windows():
        try:
            key = str(AppView(hwnd=hwnd).desktop_id)
        except (COMError, OSError, ValueError):
            continue
        if key in by_id:
            by_id[key]["windows"].append(dict(id=str(hwnd), title=title))
    return list(by_id.values())
