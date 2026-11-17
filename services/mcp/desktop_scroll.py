"""Windows UI Automation scrolling for the desktop MCP worker."""
import time

import win32gui
from pywinauto import Desktop
from pywinauto.controls.uiawrapper import UIAWrapper
from pywinauto.uia_element_info import UIAElementInfo
from pywinauto.uia_defines import IUIA, NoPatternInterfaceError
from comtypes import COMError
from comtypes.gen import UIAutomationClient as UIA


def scroll_container(hwnd, item, pixels=None):
    while item and win32gui.GetForegroundWindow() == hwnd:
        try:
            pattern = item.iface_scroll
            view = pattern.CurrentVerticalViewSize
            if pattern.CurrentVerticallyScrollable and 0 < view < 100:
                rect = item.rectangle()
                travel = rect.height() * (100 / view - 1)
                if travel <= 0:
                    raise ValueError("Hauteur de défilement indisponible.")
                if pixels is None:
                    return item
                start = pattern.CurrentVerticalScrollPercent
                end = min(100, max(0, start + pixels * 100 / travel))
                pattern.SetScrollPercent(-1, end)
                deadline = time.monotonic() + 1
                while True:
                    actual = pattern.CurrentVerticalScrollPercent
                    if abs(actual - end) * travel / 100 < 1 or time.monotonic() >= deadline:
                        break
                    time.sleep(0.05)
                return dict(requested=pixels, moved=round((actual - start) * travel / 100))
        except NoPatternInterfaceError:
            pass
        if item.element_info.handle == hwnd:
            break
        item = item.parent()
    raise ValueError("Aucun conteneur défilable accessible à cette position.")


def scroll_pixels(hwnd, x, y, pixels):
    return scroll_container(hwnd, Desktop(backend="uia").from_point(x, y), pixels)


def named_items(hwnd):
    api = IUIA().iuia
    request = api.CreateCacheRequest()
    for prop in (UIA.UIA_NamePropertyId, UIA.UIA_RuntimeIdPropertyId, UIA.UIA_IsOffscreenPropertyId):
        request.AddProperty(prop)
    elements = api.ElementFromHandle(hwnd).FindAllBuildCache(
        UIA.TreeScope_Descendants, api.CreateTrueCondition(), request)
    items = {}
    for i in range(elements.Length):
        el = elements.GetElement(i)
        if el.CachedName:
            key = (tuple(el.GetCachedPropertyValue(UIA.UIA_RuntimeIdPropertyId)), el.CachedName)
            items[key] = el
    return items


def follow_content(hwnd, before, target):
    deadline = time.monotonic() + 2
    while win32gui.GetForegroundWindow() == hwnd:
        items = named_items(hwnd)
        candidates = [(key, el) for key, el in items.items()
                      if (key not in before if target is True else key[1].casefold() == target.casefold())]
        if candidates:
            break
        if time.monotonic() >= deadline:
            return dict(status="no_target")
        time.sleep(0.15)
    else:
        return dict(status="window_changed")
    if isinstance(target, str) and len(candidates) > 1:
        return dict(status="ambiguous", matches=len(candidates))
    # Prefer new offscreen content over visible status or button label changes.
    (_, name), el = max(candidates, key=lambda pair: bool(pair[1].CachedIsOffscreen))
    if not el.CurrentIsOffscreen:
        return dict(status="visible", label=name)
    item = UIAWrapper(UIAElementInfo(el))
    try:
        item.iface_scroll_item.ScrollIntoView()
    except (NoPatternInterfaceError, COMError):
        container = scroll_container(hwnd, item.parent())
        rect = item.rectangle()
        if rect.height() <= 0:
            return dict(status="unavailable", label=name)
        scroll_container(hwnd, container, rect.mid_point().y - container.rectangle().mid_point().y)
    time.sleep(0.15)
    return dict(status="unavailable" if el.CurrentIsOffscreen else "revealed", label=name)
