use std::process::Command;

#[tauri::command]
pub fn app_version() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "revision": env!("WAKE_BUILD_REVISION"),
        "revisionDate": env!("WAKE_REVISION_DATE"),
        "builtAt": env!("WAKE_BUILT_AT"),
        "dirty": env!("WAKE_BUILD_DIRTY"),
        "debug": cfg!(debug_assertions)
    })
}

fn run(action: &str) -> Result<serde_json::Value, String> {
    // cargo run/debug builds never fetch or install, even with a production profile.
    if cfg!(debug_assertions) || std::env::var("MIND_WAKE_DEV").as_deref() == Ok("1") {
        return Ok(serde_json::json!({"state": "disabled", "development": true}));
    }
    let repo = std::env::var_os("MIND_WAKE_REPO_DIR").ok_or("Installation inconnue")?;
    let node = std::env::var_os("MIND_WAKE_NODE").unwrap_or_else(|| "node".into());
    let mut command = Command::new(node);
    command.arg(std::path::PathBuf::from(repo).join("scripts/app-update.mjs")).arg(action);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err("Mise à jour indisponible ; consulter installation/update.log".into()); }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn app_update(check: bool) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(if check { "check" } else { "status" }))
        .await.map_err(|e| e.to_string())?
}

pub fn start() {
    std::thread::spawn(|| loop {
        let _ = run("check");
        std::thread::sleep(std::time::Duration::from_secs(5 * 60));
    });
}
