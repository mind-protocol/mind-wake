//! Per-user login setting, shared with the installation CLI.
use std::process::Command;
use tauri::{AppHandle, Manager, Wry};
use tauri::menu::CheckMenuItem;

pub struct StartupMenu(pub CheckMenuItem<Wry>);

fn setting(action: &str) -> Result<bool, String> {
    let repo = std::env::var_os("MIND_WAKE_REPO_DIR").map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let node = std::env::var_os("MIND_WAKE_NODE").unwrap_or_else(|| "node".into());
    let mut command = Command::new(node);
    command.arg(repo.join("scripts/windows-integration.mjs")).arg(action);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into()); }
    let state: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    state["startWithWindows"].as_bool().ok_or_else(|| "Invalid startup state".into())
}

pub fn refresh(app: &AppHandle, toggle: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(menu) = app.try_state::<StartupMenu>() else { return };
        let _ = menu.0.set_enabled(false);
        let result = setting("status").and_then(|enabled| {
            if toggle { setting(if enabled { "disable" } else { "enable" }) } else { Ok(enabled) }
        });
        match result {
            Ok(enabled) => {
                let _ = menu.0.set_checked(enabled);
                let _ = menu.0.set_text("Démarrer avec Windows");
            }
            Err(error) => {
                eprintln!("Windows startup: {error}");
                let _ = menu.0.set_checked(false);
                let _ = menu.0.set_text("Démarrer avec Windows — erreur (réessayer)");
            }
        }
        let _ = menu.0.set_enabled(true);
    });
}
