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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MenuRect { left: i32, top: i32, right: i32, bottom: i32 }

fn menu_position(x: i32, y: i32, width: u32, height: u32, screen: MenuRect, menus: &[MenuRect]) -> Option<PhysicalPosition<i32>> {
    let (w, h) = (i32::try_from(width).ok()?, i32::try_from(height).ok()?);
    if w > screen.right - screen.left || h > screen.bottom - screen.top { return None; }
    let cx = |v: i32| v.clamp(screen.left, screen.right - w);
    let cy = |v: i32| v.clamp(screen.top, screen.bottom - h);
    let gap = 8;
    let mut candidates = Vec::new();
    for m in menus {
        candidates.extend([
            (m.right + gap, cy(m.top)), (m.left - gap - w, cy(m.top)),
            (cx(m.left), m.bottom + gap), (cx(m.left), m.top - gap - h),
        ]);
    }
    // Boundary combinations also cover several native submenus and screen corners.
    let mut xs = vec![cx(x), screen.left, screen.right - w];
    let mut ys = vec![cy(y), screen.top, screen.bottom - h];
    for m in menus {
        xs.extend([m.right + gap, m.left - gap - w]);
        ys.extend([m.bottom + gap, m.top - gap - h]);
    }
    for px in xs { for &py in &ys { candidates.push((px, py)); } }
    candidates.into_iter().find(|&(px, py)| {
        px >= screen.left && py >= screen.top && px + w <= screen.right && py + h <= screen.bottom &&
        menus.iter().all(|m| px + w <= m.left - gap || px >= m.right + gap || py + h <= m.top - gap || py >= m.bottom + gap)
    }).map(|(px, py)| PhysicalPosition::new(px, py))
}

fn show(app: &AppHandle, target: ClickTarget, menus: &[MenuRect]) {
    if !ENABLED.load(Ordering::Relaxed) || SENDING.load(Ordering::Relaxed) { return; }
    let Some(window) = app.get_webview_window("quick-input") else { return; };
    let (x,y) = (target.x,target.y);
    let Ok(monitors) = window.available_monitors() else { return; };
    let Some(monitor) = monitors.iter().find(|m| {
        let p=m.position(); let s=m.size();
        x >= p.x && y >= p.y && (x as i64) < p.x as i64 + s.width as i64 && (y as i64) < p.y as i64 + s.height as i64
    }) else { return; };
    let Ok(size) = window.outer_size() else { return; };
    let p = monitor.position(); let s = monitor.size();
    let screen = MenuRect { left: p.x, top: p.y, right: p.x + s.width as i32, bottom: p.y + s.height as i32 };
    let Some(position) = menu_position(x, y, size.width, size.height, screen, menus) else { return; };
    if window.set_position(position).is_err() { return; }
    DISMISSED.store(false, Ordering::SeqCst);
    if let Ok(mut point) = CLICK_POINT.lock() { *point = Some(target); }
    show_without_focus(&window);
    let _ = window.emit("quick-opened", target);
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)] #[derive(Clone, Copy)] struct Point { x: i32, y: i32 }
    #[repr(C)] #[derive(Default)] struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
    #[repr(C)] struct Mouse { point: Point, data: u32, flags: u32, time: u32, extra: usize }
    #[repr(C)] struct Message { hwnd: Handle, message: u32, wparam: usize, lparam: isize, time: u32, point: Point, private: u32 }
    enum InputAction { Open(ClickTarget, u64), Dismiss }
    static CLICKS: OnceLock<mpsc::SyncSender<InputAction>> = OnceLock::new();
    static DISMISS_RIGHT_UP: AtomicBool = AtomicBool::new(false);
    static INPUT_ACTIVITY: AtomicU64 = AtomicU64::new(0);
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
        fn EnumWindows(callback: unsafe extern "system" fn(Handle, isize) -> i32, data: isize) -> i32;
        fn GetWindowRect(window: Handle, rect: *mut Rect) -> i32;
        fn GetWindowThreadProcessId(window: Handle, process: *mut u32) -> u32;
        fn GetWindowLongPtrW(window: Handle, index: i32) -> isize;
    }
    #[link(name="kernel32")]
    unsafe extern "system" { fn GetModuleHandleW(name: *const u16) -> Handle; }
    struct MenuSearch { target: ClickTarget, process: u32, rects: Vec<MenuRect> }
    unsafe extern "system" fn collect_menu(window: Handle, data: isize) -> i32 {
        let search = &mut *(data as *mut MenuSearch);
        if IsWindowVisible(window) == 0 || window as isize == search.target.root_window ||
            window as isize == INPUT_HWND.load(Ordering::Relaxed) { return 1; }
        let mut process = 0;
        GetWindowThreadProcessId(window, &mut process);
        let mut class = [0u16; 96];
        let count = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
        let class = String::from_utf16_lossy(&class[..count.max(0) as usize]);
        // Standard Win32 menus and modern Explorer popups. Other visible popup
        // windows in the clicked application are obstacles too (custom menus).
        let shell_menu = matches!(class.as_str(), "#32768" | "Xaml_WindowedPopupClass" | "Microsoft.UI.Content.PopupWindowSiteBridge");
        if !shell_menu && (process != search.process || GetWindowLongPtrW(window, -16) & 0x80000000 == 0) { return 1; }
        let mut r = Rect::default();
        if GetWindowRect(window, &mut r) == 0 || r.right <= r.left || r.bottom <= r.top { return 1; }
        let t = search.target;
        if t.x < r.left - 96 || t.x > r.right + 96 || t.y < r.top - 96 || t.y > r.bottom + 96 { return 1; }
        search.rects.push(MenuRect {left:r.left,top:r.top,right:r.right,bottom:r.bottom});
        1
    }
    fn context_menus(target: ClickTarget) -> Vec<MenuRect> {
        let mut search = MenuSearch { target, process: 0, rects: Vec::new() };
        unsafe {
            GetWindowThreadProcessId(target.root_window as Handle, &mut search.process);
            if search.process != 0 { EnumWindows(collect_menu, &mut search as *mut MenuSearch as isize); }
        }
        search.rects
    }
    pub fn show_without_focus(window: &tauri::WebviewWindow) {
        if let Ok(hwnd) = window.hwnd() {
            // SW_SHOWNOACTIVATE: keep the application's native menu and draft focus.
            unsafe { ShowWindow(hwnd.0 as Handle, 4); }
        }
    }
    unsafe extern "system" fn mouse(code: i32, wparam: usize, lparam: isize) -> isize {
        // A non-activating window never receives blur until it has gained focus.
        // Observe all outside button presses, including accessibility/synthetic
        // input and side buttons. Only opening is restricted to physical input.
        // Never consume the click: the underlying application still receives it.
        if code >= 0 && matches!(wparam, 0x201 | 0x204 | 0x207 | 0x20b) {
            INPUT_ACTIVITY.fetch_add(1, Ordering::Relaxed);
            let event = &*(lparam as *const Mouse);
            let input = INPUT_HWND.load(Ordering::Relaxed);
            if wparam == 0x204 { DISMISS_RIGHT_UP.store(false, Ordering::Relaxed); }
            if IsWindowVisible(input as Handle) != 0 &&
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
                    let _=tx.try_send(InputAction::Open(ClickTarget {id:NEXT_CLICK.fetch_add(1,Ordering::Relaxed),x:event.point.x,y:event.point.y,at_ms,root_window:target as isize}, INPUT_ACTIVITY.load(Ordering::Relaxed)));
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
    unsafe extern "system" fn keyboard(code: i32, wparam: usize, lparam: isize) -> isize {
        // KBDLLHOOKSTRUCT starts with vkCode. Escape also works before focus.
        if code >= 0 && matches!(wparam, 0x100 | 0x104) && *(lparam as *const u32) == 0x1b {
            INPUT_ACTIVITY.fetch_add(1, Ordering::Relaxed);
            if IsWindowVisible(INPUT_HWND.load(Ordering::Relaxed) as Handle) != 0 {
                if let Some(tx) = CLICKS.get() { let _ = tx.try_send(InputAction::Dismiss); }
            }
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
                // Let the source application's context menu finish opening. This
                // wait is on the worker, never on the hook or the UI thread.
                let menus = if let InputAction::Open(target, activity) = &action {
                    let mut menus = Vec::new();
                    for tick in 0..10 {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        if INPUT_ACTIVITY.load(Ordering::Relaxed) != *activity { break; }
                        let next = context_menus(*target);
                        let stable = !next.is_empty() && next == menus && tick >= 3;
                        menus = next;
                        if stable { break; }
                    }
                    menus
                } else { Vec::new() };
                let handle=app.clone();
                let _=app.run_on_main_thread(move || match action {
                    InputAction::Open(target, activity) => {
                        if INPUT_ACTIVITY.load(Ordering::Relaxed) == activity { show(&handle,target,&menus); }
                    }
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
        let screen = MenuRect {left:0,top:0,right:1920,bottom:1080};
        assert_eq!(menu_position(1910,1070,440,240,screen,&[]),Some(PhysicalPosition::new(1480,840)));
        let screen = MenuRect {left:-1920,top:-200,right:0,bottom:880};
        assert_eq!(menu_position(-1900,-180,440,240,screen,&[]),Some(PhysicalPosition::new(-1900,-180)));
        assert_eq!(menu_position(-20,870,440,240,screen,&[]),Some(PhysicalPosition::new(-440,640)));
    }
    #[test] fn puts_wake_beside_native_menu_and_flips_at_right_edge() {
        let screen = MenuRect {left:0,top:0,right:1920,bottom:1080};
        let menu = MenuRect {left:400,top:300,right:700,bottom:700};
        assert_eq!(menu_position(400,300,460,240,screen,&[menu]),Some(PhysicalPosition::new(708,300)));
        let menu = MenuRect {left:1600,top:680,right:1920,bottom:1080};
        assert_eq!(menu_position(1900,1000,460,240,screen,&[menu]),Some(PhysicalPosition::new(1132,680)));
    }
    #[test] fn moves_below_when_neither_side_fits_and_refuses_to_cover_full_screen_menu() {
        let screen = MenuRect {left:0,top:0,right:800,bottom:800};
        let menu = MenuRect {left:250,top:100,right:550,bottom:400};
        assert_eq!(menu_position(250,100,460,240,screen,&[menu]),Some(PhysicalPosition::new(250,408)));
        assert_eq!(menu_position(250,100,460,240,screen,&[screen]),None);
        assert_eq!(menu_position(250,100,900,240,screen,&[]),None);
    }
    #[test] fn placement_never_intersects_native_menus_across_screen_edges_and_dpi_sizes() {
        for origin in [(-1920,-200),(0,0)] {
            let screen = MenuRect {left:origin.0,top:origin.1,right:origin.0+1920,bottom:origin.1+1080};
            for dx in [0,200,900,1600] { for dy in [0,300,680] { for (w,h) in [(460,240),(690,360)] {
                let menu = MenuRect {left:origin.0+dx,top:origin.1+dy,right:origin.0+dx+320,bottom:origin.1+dy+400};
                let submenu = MenuRect {left:menu.right,top:menu.top+30,right:menu.right+250,bottom:menu.top+330};
                let menus = [menu,submenu];
                let position = menu_position(menu.left,menu.top,w,h,screen,&menus).expect("free space exists");
                assert!(position.x >= screen.left && position.y >= screen.top);
                assert!(position.x + w as i32 <= screen.right && position.y + h as i32 <= screen.bottom);
                for m in menus { assert!(position.x + w as i32 <= m.left || position.x >= m.right || position.y + h as i32 <= m.top || position.y >= m.bottom); }
            } } }
        }
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
