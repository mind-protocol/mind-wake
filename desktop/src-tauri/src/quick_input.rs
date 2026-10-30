//! Global right-button observer. The hook only queues coordinates; UI and capture
//! never run on the Windows hook thread. Native context menus keep receiving clicks.
use std::sync::{atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering}, mpsc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

pub static ENABLED: AtomicBool = AtomicBool::new(true);
pub static SENDING: AtomicBool = AtomicBool::new(false);
pub static DISMISSED: AtomicBool = AtomicBool::new(true);
static INPUT_HWND: AtomicIsize = AtomicIsize::new(0);
static CLICK_POINT: std::sync::Mutex<Option<ClickTarget>> = std::sync::Mutex::new(None);
static UNCONFIRMED_POINT: std::sync::Mutex<Option<ClickTarget>> = std::sync::Mutex::new(None);
static NEXT_CLICK: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy, serde::Serialize)]
pub struct ClickTarget { pub id: u64, pub x: i32, pub y: i32, pub at_ms: u64, pub root_window: isize }

pub fn click_point(id: u64) -> Result<ClickTarget, String> {
    let pending = UNCONFIRMED_POINT.lock().ok().and_then(|point| *point).filter(|point| point.id == id);
    CLICK_POINT.lock().ok().and_then(|point| *point)
        .filter(|point| point.id == id)
        .or(pending)
        .ok_or_else(|| "POINT_REFRESH_REQUIRED: Point du clic indisponible ou remplacé. Refaire un clic droit ; aucun message envoyé.".into())
}
pub fn mark_unconfirmed(point: ClickTarget) { if let Ok(mut pending) = UNCONFIRMED_POINT.lock() { *pending = Some(point); } }
pub fn finish_point(id: u64, refresh: bool) {
    if let Ok(mut pending) = UNCONFIRMED_POINT.lock() { if pending.as_ref().is_some_and(|p| p.id == id) { *pending = None; } }
    if refresh { if let Ok(mut point) = CLICK_POINT.lock() { if point.as_ref().is_some_and(|p| p.id == id) { *point = None; } } }
}

pub fn show_without_focus(window: &tauri::WebviewWindow) {
    #[cfg(windows)] { native::show_without_focus(window); }
    #[cfg(not(windows))] { let _ = window.show(); }
}

pub fn dismiss(window: &tauri::WebviewWindow) -> Result<(), String> {
    DISMISSED.store(true, Ordering::SeqCst);
    window.hide().map_err(|e| e.to_string())
}

fn clamp_origin(value: i32, origin: i32, extent: u32, size: u32) -> i32 {
    value.clamp(origin, origin.saturating_add(extent.saturating_sub(size) as i32))
}

fn show(app: &AppHandle, target: ClickTarget) {
    if !ENABLED.load(Ordering::Relaxed) || SENDING.load(Ordering::Relaxed) { return; }
    let Some(window) = app.get_webview_window("quick-input") else { return; };
    DISMISSED.store(false, Ordering::SeqCst);
    let (x,y) = (target.x,target.y);
    if let Ok(mut point) = CLICK_POINT.lock() { *point = Some(target); }
    let mut position = PhysicalPosition::new(x, y);
    if let Ok(monitors) = window.available_monitors() {
        if let Some(monitor) = monitors.iter().find(|m| {
            let p=m.position(); let s=m.size();
            x >= p.x && y >= p.y && (x as i64) < p.x as i64 + s.width as i64 && (y as i64) < p.y as i64 + s.height as i64
        }) {
            if let Ok(size) = window.outer_size() {
                position.x = clamp_origin(x, monitor.position().x, monitor.size().width, size.width);
                position.y = clamp_origin(y, monitor.position().y, monitor.size().height, size.height);
            }
        }
    }
    let _ = window.set_position(position);
    show_without_focus(&window);
    let _ = window.emit("quick-opened", target);
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)] #[derive(Clone, Copy)] struct Point { x: i32, y: i32 }
    #[repr(C)] struct Mouse { point: Point, data: u32, flags: u32, time: u32, extra: usize }
    #[repr(C)] struct Message { hwnd: Handle, message: u32, wparam: usize, lparam: isize, time: u32, point: Point, private: u32 }
    enum InputAction { Open(ClickTarget), Dismiss }
    static CLICKS: OnceLock<mpsc::SyncSender<InputAction>> = OnceLock::new();
    static DISMISS_RIGHT_UP: AtomicBool = AtomicBool::new(false);
    #[link(name="user32")]
    unsafe extern "system" {
        fn SetWindowsHookExW(kind: i32, callback: Option<unsafe extern "system" fn(i32,usize,isize)->isize>, module: Handle, thread: u32) -> Handle;
        fn CallNextHookEx(hook: Handle, code: i32, wparam: usize, lparam: isize) -> isize;
        fn UnhookWindowsHookEx(hook: Handle) -> i32;
        fn GetMessageW(message: *mut Message, hwnd: Handle, min: u32, max: u32) -> i32;
        fn WindowFromPoint(point: Point) -> Handle;
        fn GetAncestor(window: Handle, flags: u32) -> Handle;
        fn GetClassNameW(window: Handle, name: *mut u16, count: i32) -> i32;
        fn ShowWindow(window: Handle, command: i32) -> i32;
        fn IsWindowVisible(window: Handle) -> i32;
    }
    #[link(name="kernel32")]
    unsafe extern "system" { fn GetModuleHandleW(name: *const u16) -> Handle; }
    pub fn show_without_focus(window: &tauri::WebviewWindow) {
        if let Ok(hwnd) = window.hwnd() {
            // SW_SHOWNOACTIVATE: keep the application's native menu and draft focus.
            unsafe { ShowWindow(hwnd.0 as Handle, 4); }
        }
    }
    unsafe extern "system" fn mouse(code: i32, wparam: usize, lparam: isize) -> isize {
        // A non-activating window never receives blur until it has gained focus.
        // Observe outside button presses directly, without consuming the click.
        if code >= 0 && matches!(wparam, 0x201 | 0x204 | 0x207) {
            let event = &*(lparam as *const Mouse);
            let input = INPUT_HWND.load(Ordering::Relaxed);
            if wparam == 0x204 && event.flags & 1 == 0 { DISMISS_RIGHT_UP.store(false, Ordering::Relaxed); }
            if event.flags & 1 == 0 && IsWindowVisible(input as Handle) != 0 &&
                GetAncestor(WindowFromPoint(event.point), 2) as isize != input {
                if wparam == 0x204 { DISMISS_RIGHT_UP.store(true, Ordering::Relaxed); }
                if let Some(tx) = CLICKS.get() { let _ = tx.try_send(InputAction::Dismiss); }
            }
        }
        // WM_RBUTTONUP, physical events only. Ignore the input itself and native menus.
        if code >= 0 && wparam == 0x205 && ENABLED.load(Ordering::Relaxed) {
            let event = &*(lparam as *const Mouse);
            // The same outside right-click must not close on down and reopen on up.
            if event.flags & 1 == 0 && DISMISS_RIGHT_UP.swap(false, Ordering::Relaxed) {
                return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
            }
            let target = GetAncestor(WindowFromPoint(event.point), 2);
            let mut class = [0u16; 32];
            let count = GetClassNameW(target, class.as_mut_ptr(), class.len() as i32);
            let menu = count > 0 && String::from_utf16_lossy(&class[..count as usize]) == "#32768";
            if event.flags & 1 == 0 && target as isize != INPUT_HWND.load(Ordering::Relaxed) && !menu {
                if let Some(tx) = CLICKS.get() {
                    let at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d|d.as_millis() as u64).unwrap_or(0);
                    let _=tx.try_send(InputAction::Open(ClickTarget {id:NEXT_CLICK.fetch_add(1,Ordering::Relaxed),x:event.point.x,y:event.point.y,at_ms,root_window:target as isize}));
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
    unsafe extern "system" fn keyboard(code: i32, wparam: usize, lparam: isize) -> isize {
        // KBDLLHOOKSTRUCT starts with vkCode. Escape also works before focus.
        if code >= 0 && matches!(wparam, 0x100 | 0x104) && *(lparam as *const u32) == 0x1b &&
            IsWindowVisible(INPUT_HWND.load(Ordering::Relaxed) as Handle) != 0 {
            if let Some(tx) = CLICKS.get() { let _ = tx.try_send(InputAction::Dismiss); }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
    pub fn start(app: AppHandle) -> Result<(), String> {
        let window = app.get_webview_window("quick-input").ok_or("Fenêtre de saisie absente")?;
        INPUT_HWND.store(window.hwnd().map_err(|e| e.to_string())?.0 as isize, Ordering::Relaxed);
        let (tx,rx)=mpsc::sync_channel(16);
        CLICKS.set(tx).map_err(|_| "Hook déjà installé")?;
        let (ready_tx,ready_rx)=mpsc::sync_channel(1);
        std::thread::spawn(move || unsafe {
            let hook=SetWindowsHookExW(14,Some(mouse),GetModuleHandleW(std::ptr::null()),0);
            let keys=SetWindowsHookExW(13,Some(keyboard),GetModuleHandleW(std::ptr::null()),0);
            let _=ready_tx.send(!hook.is_null() && !keys.is_null());
            if hook.is_null() || keys.is_null() {
                if !hook.is_null() { UnhookWindowsHookEx(hook); }
                if !keys.is_null() { UnhookWindowsHookEx(keys); }
                return;
            }
            let mut message: Message=std::mem::zeroed();
            while GetMessageW(&mut message,std::ptr::null_mut(),0,0)>0 {}
            UnhookWindowsHookEx(hook);
            UnhookWindowsHookEx(keys);
        });
        if !ready_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(false) {
            ENABLED.store(false,Ordering::Relaxed);
            return Err("Clic droit global indisponible".into());
        }
        std::thread::spawn(move || {
            while let Ok(action)=rx.recv() {
                let handle=app.clone();
                let _=app.run_on_main_thread(move || match action {
                    InputAction::Open(target) => show(&handle,target),
                    InputAction::Dismiss => { if let Some(window) = handle.get_webview_window("quick-input") { let _ = dismiss(&window); } }
                });
            }
        });
        Ok(())
    }
}
pub fn start(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)] { native::start(app) }
    #[cfg(not(windows))] { let _=app; Err("Fonction Windows uniquement".into()) }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn keeps_input_inside_monitor_including_negative_coordinates() {
        assert_eq!(clamp_origin(1910,0,1920,440),1480);
        assert_eq!(clamp_origin(-1900,-1920,1920,440),-1900);
        assert_eq!(clamp_origin(-20,-1920,1920,440),-440);
        assert_eq!(clamp_origin(0,0,320,440),0);
    }
    #[test] fn sends_only_the_exact_native_click_and_rejects_a_replaced_target() {
        *CLICK_POINT.lock().unwrap() = Some(ClickTarget { id: 27, x: -210, y: 48, at_ms: 1, root_window: 42 });
        assert_eq!(click_point(27).map(|p|(p.x,p.y)), Ok((-210,48)));
        assert!(click_point(26).is_err());
        *CLICK_POINT.lock().unwrap() = None;
        assert!(click_point(27).is_err());
        mark_unconfirmed(ClickTarget {id:28,x:14,y:15,at_ms:2,root_window:43});
        *CLICK_POINT.lock().unwrap() = Some(ClickTarget {id:29,x:44,y:45,at_ms:3,root_window:44});
        assert_eq!(click_point(28).map(|p|(p.x,p.y)),Ok((14,15)));
        finish_point(28,false);
        assert!(click_point(28).is_err());
        finish_point(29,true);
        assert!(click_point(29).is_err());
    }
}
