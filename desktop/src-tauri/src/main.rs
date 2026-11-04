//! MIND Wake desktop : icône de zone de notification avec voyant, sélecteur
//! On / Réveil / Force-off, panneau « Que fait mon agent ? » et fils privés (SPEC §21,
//! §23). Client local des CLI : fermer ou faire planter le panneau n'arrête ni ne relance
//! Wake ; chaque action est la commande CLI correspondante (ADR-007, agent-first).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod runtime_paths;
mod quick_input;
mod paint;
mod windows_startup;
mod updates;
mod startup_receipt;
mod documents;
mod series_assembly;
mod series_assembly_data;
mod conversation_images;
mod external_urls;
mod authorizations;
mod i18n;

use cli::{CliRun, OwnerRequest, Verb};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry, WindowEvent, Listener, Emitter};

/// Intervalle du voyant de l'icône, indépendant du panneau (qui relit toutes les 2 s).
const LIGHT_POLL: Duration = Duration::from_secs(3);

#[tauri::command]
fn app_restart(app: AppHandle) {
    if std::env::var("MIND_WAKE_DESKTOP_SUPERVISED").as_deref() == Ok("1") {
        // The supervisor reloads the installation manifest, including installed updates.
        app.exit(75);
    } else {
        app.restart();
    }
}

#[tauri::command]
fn app_fullscreen(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_fullscreen(enabled).map_err(|e| e.to_string())
}

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
async fn onboarding_status() -> Result<CliRun, String> {
    blocking(|| cli::onboarding(false, false)).await
}

#[tauri::command]
async fn onboarding_start(accept_native: bool) -> Result<CliRun, String> {
    blocking(move || cli::onboarding(true, accept_native)).await
}

#[tauri::command]
async fn wake_restart() -> Result<CliRun, String> {
    blocking(cli::restart_daemon).await
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
async fn wake_on() -> Result<CliRun, String> { blocking(|| cli::wake(Verb::On)).await }

#[tauri::command]
async fn wake_always_on() -> Result<CliRun, String> { blocking(cli::always_on).await }

#[tauri::command]
async fn wake_now() -> Result<CliRun, String> {
    blocking(cli::wake_now).await
}

#[tauri::command]
async fn wake_messages() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Messages)).await
}

#[tauri::command]
async fn wake_history() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::WakeHistory)).await
}

#[tauri::command]
async fn wake_order(revision: u64, project_ids: Vec<String>) -> Result<CliRun, String> {
    blocking(move || cli::wake_order(revision, project_ids)).await
}

#[tauri::command]
async fn second_thread(action: String, text: Option<String>) -> Result<CliRun, String> {
    blocking(move || cli::second_thread(&action, text)).await
}
#[tauri::command]
async fn wake_coach(action: String, text: Option<String>) -> Result<CliRun, String> {
    blocking(move || cli::wake_coach(&action, text)).await
}

#[tauri::command]
async fn wake_forks(action: String, id: Option<u8>, text: Option<String>) -> Result<CliRun, String> {
    blocking(move || cli::wake_forks(&action, id, text)).await
}

#[tauri::command]
async fn workspace_sync_status() -> Result<CliRun, String> {
    blocking(|| cli::workspace_sync("status", None)).await
}

#[tauri::command]
async fn elevenlabs(action: String, payload: Option<serde_json::Value>) -> Result<CliRun, String> {
    blocking(move || cli::elevenlabs(action, payload)).await
}

#[tauri::command]
async fn workspace_sync_configure(workspace_dir: String, github_url: String, enabled: bool) -> Result<CliRun, String> {
    blocking(move || cli::workspace_sync("configure", Some((workspace_dir, github_url, enabled)))).await
}

#[tauri::command]
async fn workspace_sync_now() -> Result<CliRun, String> {
    blocking(|| cli::workspace_sync("now", None)).await
}

#[tauri::command]
async fn wake_open_location(kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cli::open_wake_location(&kind))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || external_urls::open(&url))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wake_reply(idempotency_key: String, text: String) -> Result<CliRun, String> {
    blocking(move || cli::wake_reply(idempotency_key, text)).await
}

#[tauri::command]
async fn voice_input(action: String, audio: Option<String>) -> Result<CliRun, String> {
    blocking(move || cli::voice_input(action, audio)).await
}

#[tauri::command]
async fn broadcast_status() -> Result<CliRun,String> { blocking(||cli::broadcast("status",None,None)).await }
#[tauri::command]
async fn broadcast_send(idempotency_key:String,text:String) -> Result<CliRun,String> { blocking(move||cli::broadcast("send",Some(idempotency_key),Some(text))).await }

#[tauri::command]
async fn recipient_status() -> Result<CliRun, String> { blocking(|| cli::recipient("status",None,None)).await }
#[tauri::command]
async fn recipient_poll() -> Result<CliRun, String> { blocking(|| cli::recipient("poll",None,None)).await }
#[tauri::command]
async fn recipient_send(idempotency_key:String,text:String) -> Result<CliRun,String> { blocking(move || cli::recipient("send",Some(idempotency_key),Some(text))).await }

#[tauri::command]
async fn helpers_answers() -> Result<CliRun, String> {
    blocking(cli::helpers_answers).await
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
            Light::Awake => i18n::text("MIND Wake — éveillé : une session tourne", "MIND Wake — awake: a session is running"),
            Light::On => i18n::text("MIND Wake — allumé : réveils autorisés dans les fenêtres", "MIND Wake — on: wakes allowed in scheduled windows"),
            Light::Off => i18n::text("MIND Wake — éteint (pause, blocage ou désactivé)", "MIND Wake — off (paused, blocked or disabled)"),
            Light::ForcedOff => i18n::text("MIND Wake — arrêt forcé (arrêt d'urgence)", "MIND Wake — forced off (emergency stop)"),
            Light::Unknown => i18n::text("MIND Wake — état indisponible", "MIND Wake — status unavailable"),
        }
    }
}

/// Sélecteur On / Réveil / Force-off du menu : coché d'après l'état réel, jamais d'après
/// le dernier clic.
struct Switch {
    on: CheckMenuItem<Wry>,
    wake: CheckMenuItem<Wry>,
    always: CheckMenuItem<Wry>,
    off: CheckMenuItem<Wry>,
}

impl Switch {
    fn show(&self, light: Light, always_on: bool) {
        let _ = self.on.set_checked(light == Light::On && !always_on);
        let _ = self.wake.set_checked(light == Light::Awake && !always_on);
        let _ = self.off.set_checked(light == Light::ForcedOff);
        let _ = self.always.set_checked(always_on);
        // Selecting Always-on explicitly reactivates through the validated CLI path.
        let _ = self.always.set_enabled(true);
        // Après un arrêt d'urgence, seule une commande explicite hors menu peut relancer.
        let _ = self.on.set_enabled(light != Light::ForcedOff);
        let _ = self.wake.set_enabled(light != Light::ForcedOff);
    }
}

fn refresh_light(tray: &TrayIcon<Wry>, switch: &Switch) {
    let status = cli::wake(Verb::Status);
    let light = Light::of(&status);
    let always_on = status.as_ref().ok().and_then(|r| serde_json::from_str::<serde_json::Value>(&r.stdout).ok()).map(|j| j["data"]["executionMode"] == "always-on" && matches!(light, Light::On | Light::Awake)).unwrap_or(false);
    if let Ok(icon) = Image::from_bytes(light.icon()) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(light.tooltip()));
    switch.show(light, always_on);
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
        let _ = if matches!(verb, Verb::Wake) { cli::wake_now() } else if matches!(verb, Verb::AlwaysOn) { cli::always_on() } else { cli::wake(verb) };
        if let (Some(tray), Some(switch)) = (app.tray_by_id("wake"), app.try_state::<Switch>()) {
            refresh_light(&tray, &switch);
        }
    });
}

fn main() {
    runtime_paths::load();
    tauri::Builder::default()
        .on_page_load(|_webview, payload| {
            if let Some(file) = std::env::var_os("MIND_WAKE_STARTUP_RECEIPT") {
                let file = std::path::PathBuf::from(file).with_extension("page.json");
                let receipt = serde_json::json!({"pid":std::process::id(),"url":payload.url().as_str(),"event":format!("{:?}",payload.event())});
                let _ = std::fs::write(file,receipt.to_string());
            }
        })
        // Un seul panneau : relancer l'application (menu Démarrer) rouvre le panneau existant.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_panel(app)))
        .invoke_handler(tauri::generate_handler![
            app_restart,
            wake_restart,
            app_fullscreen,
            documents::document_browse,
            series_assembly::series_assembly,
            documents::conversation_image,
            documents::conversation_image_import,
            authorizations::authorizations_read,
            authorizations::authorizations_save,
            updates::app_update,
            updates::app_version,
            wake_status,
            onboarding_status,
            onboarding_start,
            wake_journal,
            wake_pause,
            wake_resume,
            wake_stop,
            wake_now,
            wake_on,
            wake_always_on,
            wake_messages,
            wake_history,
            wake_order,
            second_thread,
            wake_coach,
            wake_forks,
            workspace_sync_status,
            workspace_sync_configure,
            elevenlabs,
            workspace_sync_now,
            wake_open_location,
            open_external_url,
            wake_reply,
            voice_input,
            helpers_answers,
            owner_threads,
            recipient_status,
            recipient_poll,
            recipient_send,
            owner_thread,
            broadcast_status,
            broadcast_send,
            owner_reply
        ])
        .setup(|app| {
            if let Err(error)=paint::start(app.handle()) {eprintln!("Paint : {error}");}
            // Legacy right-click WebView retired; the supervised post-it observer owns this interaction.
            let open = MenuItem::with_id(app, "open", i18n::text("Ouvrir le panneau", "Open panel"), true, None::<&str>)?;
            let startup = CheckMenuItem::with_id(app, "windows_startup", i18n::text("Démarrer avec Windows", "Start with Windows"), false, false, None::<&str>)?;
            let on = CheckMenuItem::with_id(app, "mode_on", i18n::text("On — réveils autorisés", "On — wakes allowed"), true, false, None::<&str>)?;
            let wake = CheckMenuItem::with_id(app, "mode_wake", i18n::text("Réveil — maintenant", "Wake — now"), true, false, None::<&str>)?;
            let always = CheckMenuItem::with_id(app, "mode_always", i18n::text("Always-on — enchaîner les réponses", "Always-on — continue after each response"), true, false, None::<&str>)?;
            let off = CheckMenuItem::with_id(app, "mode_off", i18n::text("Force-off — arrêt d'urgence", "Force-off — emergency stop"), true, false, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", i18n::text("Quitter le panneau (Wake continue)", "Quit panel (Wake continues)"), true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &startup,
                    &PredefinedMenuItem::separator(app)?,
                    &on,
                    &wake,
                    &always,
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
                    "windows_startup" => windows_startup::refresh(app, true),
                    // « On » lève une pause ; la CLI refuse après un arrêt d'urgence.
                    "mode_on" => menu_action(app, Verb::On),
                    "mode_always" => menu_action(app, Verb::AlwaysOn),
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
            let language_on = on.clone();
            let language_wake = wake.clone();
            let language_always = always.clone();
            let language_off = off.clone();
            let language_startup = startup.clone();
            app.listen("mind-wake-language", move |event| {
                let Ok(language) = serde_json::from_str::<String>(event.payload()) else { return };
                if language != "en" && language != "fr" { return; }
                i18n::set_language(&language);
                let _ = open.set_text(i18n::text("Ouvrir le panneau", "Open panel"));
                let _ = quit.set_text(i18n::text("Quitter le panneau (Wake continue)", "Quit panel (Wake continues)"));
                let _ = language_startup.set_text(i18n::text("Démarrer avec Windows", "Start with Windows"));
                let _ = language_on.set_text(i18n::text("On — réveils autorisés", "On — wakes allowed"));
                let _ = language_wake.set_text(i18n::text("Réveil — maintenant", "Wake — now"));
                let _ = language_always.set_text(i18n::text("Always-on — enchaîner les réponses", "Always-on — continue after each response"));
                let _ = language_off.set_text(i18n::text("Force-off — arrêt d'urgence", "Force-off — emergency stop"));
            });
            app.manage(Switch { on, wake, always, off });
            app.manage(windows_startup::StartupMenu(startup));
            windows_startup::refresh(app.handle(), false);
            updates::start();
            let _ = startup_receipt::write();

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
                let _ = window.emit("voice-stop", ());
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage du panneau MIND Wake");
}
