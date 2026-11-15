//! Signale au panneau qu'un message de l'agent vient d'être écrit, sans attendre le
//! prochain tour de polling. Simple `stat` toutes les 250 ms (aucun processus lancé) sur
//! `owner-messages.sqlite` et ses fichiers annexes ; l'UI relit alors la conversation.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

const TICK: Duration = Duration::from_millis(250);
pub const EVENT: &str = "owner-messages-changed";

fn data_dir() -> Option<PathBuf> {
    std::env::var_os("MIND_WAKE_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join("mind-wake")))
}

type Stamp = Vec<Option<(SystemTime, u64)>>;

fn stamp(files: &[PathBuf]) -> Stamp {
    files
        .iter()
        .map(|file| {
            std::fs::metadata(file)
                .ok()
                .and_then(|meta| Some((meta.modified().ok()?, meta.len())))
        })
        .collect()
}

fn watched(dir: &Path) -> Vec<PathBuf> {
    ["owner-messages.sqlite", "owner-messages.sqlite-wal", "owner-messages.sqlite-journal"]
        .iter()
        .map(|name| dir.join(name))
        .collect()
}

pub fn start(app: AppHandle) {
    let Some(dir) = data_dir() else { return };
    let files = watched(&dir);
    std::thread::spawn(move || {
        let mut last = stamp(&files);
        loop {
            std::thread::sleep(TICK);
            let now = stamp(&files);
            if now != last {
                last = now;
                let _ = app.emit(EVENT, ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_changes_when_the_database_is_written() {
        let dir = std::env::temp_dir().join(format!("mw-owner-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let files = watched(&dir);
        let before = stamp(&files);
        assert!(before.iter().all(Option::is_none));
        std::fs::write(&files[0], b"one").unwrap();
        let after = stamp(&files);
        assert_ne!(before, after);
        std::fs::write(&files[0], b"two-two").unwrap();
        assert_ne!(after, stamp(&files));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
