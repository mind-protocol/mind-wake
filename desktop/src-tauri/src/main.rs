//! MIND Wake desktop : icône de zone de notification avec voyant, sélecteur
//! On / Réveil / Force-off, panneau « Que fait mon agent ? » et fils privés (SPEC §21,
//! §23). Client local des CLI : fermer ou faire planter le panneau n'arrête ni ne relance
//! Wake ; chaque action est la commande CLI correspondante (ADR-007, agent-first).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;

use cli::{CliRun, OwnerRequest, Verb};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry, WindowEvent};

/// Intervalle du voyant de l'icône, indépendant du panneau (qui relit toutes les 2 s).
const LIGHT_POLL: Duration = Duration::from_secs(3);

async fn blocking<F>(f: F) -> Result<CliRun, String>
where
    F: FnOnce() -> Result<CliRun, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wake_status() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Status)).await
}

#[tauri::command]
async fn wake_journal() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Journal)).await
}

#[tauri::command]
async fn wake_pause() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Pause)).await
}

#[tauri::command]
async fn wake_resume() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Resume)).await
}

#[tauri::command]
async fn wake_stop() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Stop)).await
}

#[tauri::command]
async fn wake_now() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Wake)).await
}

#[tauri::command]
async fn owner_threads() -> Result<CliRun, String> {
    blocking(|| cli::owner(OwnerRequest::Threads)).await
}

#[tauri::command]
async fn owner_thread(thread_id: String) -> Result<CliRun, String> {
    blocking(move || cli::owner(OwnerRequest::Thread { thread_id })).await
}

#[tauri::command]
async fn owner_reply(
    thread_id: String,
    in_reply_to: Option<String>,
    idempotency_key: String,
    text: String,
) -> Result<CliRun, String> {
    blocking(move || {
        cli::owner(OwnerRequest::Reply { thread_id, in_reply_to, idempotency_key, text })
    })
    .await
}

/// Voyant : dérivé de `profile.state` de `status --json`, comme `desktop/ui/view.ts`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Light {
    Awake,
    On,
    Off,
    ForcedOff,
    Unknown,
}

impl Light {
    fn of(run: &Result<CliRun, String>) -> Light {
        let Ok(run) = run else { return Light::Unknown };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&run.stdout) else {
            return Light::Unknown;
        };
        if json["schema"] != "mind-wake.cli" || json["schemaVersion"] != 1 {
            return Light::Unknown;
        }
        match json["data"]["profile"]["state"].as_str() {
            Some("running" | "checkpointing") => Light::Awake,
            Some("ready" | "hibernating") => Light::On,
            Some("paused" | "blocked" | "disabled") => Light::Off,
            Some("stopped") => Light::ForcedOff,
            _ => Light::Unknown,
        }
    }

    fn icon(self) -> &'static [u8] {
        match self {
            Light::Awake => include_bytes!("../icons/tray-awake.png"),
            Light::On => include_bytes!("../icons/tray-on.png"),
            Light::Off => include_bytes!("../icons/tray-off.png"),
            Light::ForcedOff => include_bytes!("../icons/tray-forced_off.png"),
            Light::Unknown => include_bytes!("../icons/tray-unknown.png"),
        }
    }

    fn tooltip(self) -> &'static str {
        match self {
            Light::Awake => "MIND Wake — éveillé : une session tourne",
            Light::On => "MIND Wake — allumé : réveils autorisés dans les fenêtres",
            Light::Off => "MIND Wake — éteint (pause, blocage ou désactivé)",
            Light::ForcedOff => "MIND Wake — arrêt forcé (arrêt d'urgence)",
            Light::Unknown => "MIND Wake — état indisponible",
        }
    }
}

/// Sélecteur On / Réveil / Force-off du menu : coché d'après l'état réel, jamais d'après
/// le dernier clic.
struct Switch {
    on: CheckMenuItem<Wry>,
    wake: CheckMenuItem<Wry>,
    off: CheckMenuItem<Wry>,
}

impl Switch {
    fn show(&self, light: Light) {
        let _ = self.on.set_checked(light == Light::On);
        let _ = self.wake.set_checked(light == Light::Awake);
        let _ = self.off.set_checked(light == Light::ForcedOff);
        // Après un arrêt d'urgence, seule une commande explicite hors menu peut relancer.
        let _ = self.on.set_enabled(light != Light::ForcedOff);
        let _ = self.wake.set_enabled(light != Light::ForcedOff);
    }
}

fn refresh_light(tray: &TrayIcon<Wry>, switch: &Switch) {
    let light = Light::of(&cli::wake(Verb::Status));
    if let Ok(icon) = Image::from_bytes(light.icon()) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(light.tooltip()));
    switch.show(light);
}

fn show_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Exécute une commande du menu puis relit l'état pour le voyant et le sélecteur.
fn menu_action(app: &AppHandle, verb: Verb) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = cli::wake(verb);
        if let (Some(tray), Some(switch)) = (app.tray_by_id("wake"), app.try_state::<Switch>()) {
            refresh_light(&tray, &switch);
        }
    });
}

fn main() {
    tauri::Builder::default()
        // Un seul panneau : relancer l'application (menu Démarrer) rouvre le panneau existant.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_panel(app)))
        .invoke_handler(tauri::generate_handler![
            wake_status,
            wake_journal,
            wake_pause,
            wake_resume,
            wake_stop,
            wake_now,
            owner_threads,
            owner_thread,
            owner_reply
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Ouvrir le panneau", true, None::<&str>)?;
            let on = CheckMenuItem::with_id(app, "mode_on", "On — réveils autorisés", true, false, None::<&str>)?;
            let wake = CheckMenuItem::with_id(app, "mode_wake", "Réveil — maintenant", true, false, None::<&str>)?;
            let off = CheckMenuItem::with_id(app, "mode_off", "Force-off — arrêt d'urgence", true, false, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter le panneau (Wake continue)", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &on,
                    &wake,
                    &off,
                    &pause,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            let tray = TrayIconBuilder::with_id("wake")
                .icon(Image::from_bytes(Light::Unknown.icon())?)
                .tooltip(Light::Unknown.tooltip())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_panel(app),
                    // « On » lève une pause ; la CLI refuse après un arrêt d'urgence.
                    "mode_on" => menu_action(app, Verb::Resume),
                    "mode_wake" => menu_action(app, Verb::Wake),
                    "mode_off" => {
                        menu_action(app, Verb::Stop);
                        show_panel(app);
                    }
                    "pause" => menu_action(app, Verb::Pause),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_panel(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(Switch { on, wake, off });

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                if let Some(switch) = handle.try_state::<Switch>() {
                    refresh_light(&tray, &switch);
                }
                std::thread::sleep(LIGHT_POLL);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer la fenêtre masque le panneau ; l'icône reste et Wake n'est pas affecté.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage du panneau MIND Wake");
}
