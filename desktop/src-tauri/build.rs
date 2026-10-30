fn main() {
    // Stamp the running binary, not the mutable installation manifest.
    let repo = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let git = |args: &[&str]| -> Option<String> {
        let output = std::process::Command::new("git").args(args).current_dir(&repo).output().ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    let revision = git(&["rev-parse", "HEAD"]).unwrap_or_default();
    let date = git(&["show", "-s", "--format=%cI", "HEAD"]).unwrap_or_default();
    let dirty = git(&["status", "--porcelain"]).map(|s| !s.is_empty());
    println!("cargo:rustc-env=WAKE_BUILD_REVISION={revision}");
    println!("cargo:rustc-env=WAKE_REVISION_DATE={date}");
    println!("cargo:rustc-env=WAKE_BUILD_DIRTY={}", dirty.map(|v| v.to_string()).unwrap_or_else(|| "unknown".into()));
    println!("cargo:rustc-env=WAKE_BUILT_AT={}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    for relative in [".git/HEAD", ".git/refs", ".git/index", "src", "scripts", "desktop/ui", "desktop/src-tauri/src", "desktop/src-tauri/build.rs", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/tauri.conf.json"] {
        println!("cargo:rerun-if-changed={}", repo.join(relative).display());
    }
    // Les commandes de l'application sont déclarées ici : sans cela, Tauri les autorise
    // à toute fenêtre. Seules celles accordées dans `capabilities/` sont invocables.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "document_browse",
            "authorizations_read",
            "authorizations_save",
            "app_update",
            "app_version",
            "app_restart",
            "wake_restart",
            "app_fullscreen",
            "wake_status",
            "wake_journal",
            "wake_pause",
            "wake_resume",
            "wake_stop",
            "wake_now",
            "wake_on",
            "wake_always_on",
            "wake_messages",
            "wake_history",
            "wake_open_location",
            "wake_reply",
            "quick_input_close",
            "quick_input_send",
            "helpers_answers",
            "owner_threads",
            "owner_thread",
            "owner_reply",
        ]),
    ))
    .expect("échec de tauri-build");
}
