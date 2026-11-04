//! Click-through primary-screen annotation. Reads modifier state, never typed text.
use tauri::{Emitter, Manager};

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)] {
        let monitor=app.primary_monitor().map_err(|e|e.to_string())?.ok_or("Écran principal indisponible")?;
        let position=*monitor.position();let size=*monitor.size();let scale=monitor.scale_factor();
        let window=tauri::WebviewWindowBuilder::new(app,"paint",tauri::WebviewUrl::App("paint.html".into()))
            .title("MIND Paint · Ctrl+Shift · Échap efface").decorations(false).transparent(true)
            .always_on_top(true).skip_taskbar(true).focused(false).resizable(false)
            .position(position.x as f64/scale,position.y as f64/scale)
            .inner_size(size.width as f64/scale,size.height as f64/scale).build().map_err(|e|e.to_string())?;
        window.set_ignore_cursor_events(true).map_err(|e|e.to_string())?;
        let handle=app.clone();
        std::thread::spawn(move || {
            #[repr(C)] struct Point {x:i32,y:i32}
            #[link(name="user32")] unsafe extern "system" {fn GetAsyncKeyState(key:i32)->i16;fn GetCursorPos(point:*mut Point)->i32;}
            let mut held=false;let mut escape=false;let mut prior=(i32::MIN,i32::MIN);
            loop {
                let Some(window)=handle.get_webview_window("paint") else {break;};
                let down=unsafe{GetAsyncKeyState(0x11)<0 && GetAsyncKeyState(0x10)<0};
                let clear=unsafe{GetAsyncKeyState(0x1b)<0};
                if clear && !escape {let _=window.emit("paint-clear",());}escape=clear;
                if down {
                    let mut point=Point{x:0,y:0};
                    if unsafe{GetCursorPos(&mut point)}!=0 && prior!=(point.x,point.y) {
                        let _=window.emit("paint-point",serde_json::json!({"x":(point.x-position.x) as f64/scale,"y":(point.y-position.y) as f64/scale,"start":!held}));
                        prior=(point.x,point.y);
                    }
                } else if held {let _=window.emit("paint-end",());prior=(i32::MIN,i32::MIN);}
                held=down;
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        });
    }
    Ok(())
}
