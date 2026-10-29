fn main() {
    // Les commandes de l'application sont déclarées ici : sans cela, Tauri les autorise
    // à toute fenêtre. Seules celles accordées dans `capabilities/` sont invocables.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
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
            "helpers_answers",
            "owner_threads",
            "owner_thread",
            "owner_reply",
        ]),
    ))
    .expect("échec de tauri-build");
}
