use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

#[derive(Clone, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Ringing,
    Active,
}

#[derive(Clone, serde::Deserialize, serde::Serialize, PartialEq)]
pub struct PhoneToast {
    id: String,
    label: String,
    stage: Stage,
    until: u64,
    #[serde(default)]
    ringtone: String,
}
#[derive(Default)]
pub struct PhoneState(Mutex<Option<PhoneToast>>);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
static RINGTONES: &[(&str, &[u8])] = &[
    (
        "common",
        include_bytes!("../../../lumina-prime/app/assets/ring.wav"),
    ),
    (
        "marco",
        include_bytes!("../../../lumina-prime/app/assets/ring_marco.wav"),
    ),
    (
        "vox",
        include_bytes!("../../../lumina-prime/app/assets/ring_vox.wav"),
    ),
    (
        "equerre",
        include_bytes!("../../../lumina-prime/app/assets/ring_equerre.wav"),
    ),
    (
        "rose_des_vents",
        include_bytes!("../../../lumina-prime/app/assets/ring_rose_des_vents.wav"),
    ),
    (
        "medicis",
        include_bytes!("../../../lumina-prime/app/assets/ring_medicis.wav"),
    ),
];
#[tauri::command]
pub fn phone_ringtone_keys() -> Vec<String> {
    #[cfg(windows)]
    {
        RINGTONES
            .iter()
            .filter(|(key, _)| *key != "common")
            .map(|(key, _)| key.to_string())
            .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}
#[cfg(windows)]
fn ring(on: bool, ringtone: &str) {
    #[link(name = "winmm")]
    unsafe extern "system" {
        fn PlaySoundW(sound: *const u16, module: usize, flags: u32) -> i32;
    }
    let wav = RINGTONES
        .iter()
        .find(|(key, _)| *key == ringtone)
        .unwrap_or(&RINGTONES[0])
        .1;
    unsafe {
        if on {
            PlaySoundW(wav.as_ptr().cast(), 0, 0x0004 | 0x0001 | 0x0008);
        } else {
            PlaySoundW(std::ptr::null(), 0, 0);
        }
    }
}
#[cfg(not(windows))]
fn ring(_: bool, _: &str) {}

#[tauri::command]
pub fn phone_toast_state(state: tauri::State<'_, PhoneState>) -> Option<PhoneToast> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn phone_toast_set(app: AppHandle, toast: Option<PhoneToast>) -> Result<(), String> {
    update(&app, toast, false)
}

fn update(app: &AppHandle, toast: Option<PhoneToast>, expire_only: bool) -> Result<(), String> {
    let state = app.state::<PhoneState>();
    let mut current = state.0.lock().unwrap();
    if expire_only
        && !current
            .as_ref()
            .is_some_and(|t| t.stage == Stage::Ringing && t.until <= now())
    {
        return Ok(());
    }
    let next = toast.filter(|t| t.stage == Stage::Active || t.until > now());
    if *current == next {
        return Ok(());
    }
    // Le panneau peut initialiser l'état vide avant la création de la fenêtre de sonnerie.
    let window = app
        .get_webview_window("phone-toast")
        .ok_or("Fenêtre d’appel indisponible")?;
    if current.as_ref().is_some_and(|t| t.stage == Stage::Ringing) {
        ring(false, "");
    }
    *current = next.clone();
    window
        .emit("phone-toast-change", &next)
        .map_err(|e| e.to_string())?;
    // NLR, 17 nov. 2026 : pas de toast permanent pendant l'appel ; on raccroche dans la fenêtre
    // principale (onglet Appel). Le toast ne sert plus qu'à la sonnerie d'un appel entrant.
    if next.as_ref().is_some_and(|t| t.stage == Stage::Active) {
        super::quick_input::hide(&window)?;
        super::show_panel(app);
        return Ok(());
    }
    if let Some(t) = next {
        let monitor = app
            .get_webview_window("main")
            .and_then(|w| w.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten());
        if let Some(m) = monitor {
            let area = m.work_area();
            let size = window.outer_size().map_err(|e| e.to_string())?;
            let gap = (16.0 * m.scale_factor()) as i32;
            let x = area.position.x + (area.size.width as i32 - size.width as i32 - gap).max(0);
            let y = area.position.y + (area.size.height as i32 - size.height as i32 - gap).max(0);
            window
                .set_position(PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        }
        super::quick_input::show_without_focus(&window);
        if t.stage == Stage::Ringing {
            ring(true, &t.ringtone);
        }
    } else {
        super::quick_input::hide(&window)?;
    }
    Ok(())
}

#[tauri::command]
pub fn phone_toast_action(app: AppHandle, id: String, action: String) -> Result<(), String> {
    let state = app.state::<PhoneState>();
    let current = state.0.lock().unwrap();
    let valid = current.as_ref().is_some_and(|t| {
        t.id == id
            && match t.stage {
                Stage::Ringing => {
                    t.until > now() && matches!(action.as_str(), "accept" | "decline")
                }
                Stage::Active => action == "hangup",
            }
    });
    if !valid {
        return Err("Cet appel est terminé.".into());
    }
    app.emit_to(
        "main",
        "phone-toast-action",
        serde_json::json!({ "id":id,"action":action }),
    )
    .map_err(|e| e.to_string())
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let Some(main) = app.get_webview_window("main") else {
            break;
        };
        // A native tick also reaches a minimized panel, where browser timers are throttled.
        let _ = main.emit("phone-poll", ());
        let _ = update(&app, None, true);
    });
}
