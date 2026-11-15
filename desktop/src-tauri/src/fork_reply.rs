use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(serde::Deserialize, serde::Serialize)]
pub struct ReplyDraft {
    turn: String,
    text: String,
    at: u64,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct IncomingDraft {
    from: u8,
    to: u8,
    text: String,
    at: u64,
}

#[derive(serde::Serialize)]
pub struct LiveDrafts {
    reply: Option<ReplyDraft>,
    incoming: Vec<IncomingDraft>,
}

fn read<T: serde::de::DeserializeOwned>(file: &Path, limit: u64) -> Option<T> {
    let metadata = std::fs::symlink_metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    serde_json::from_reader(std::fs::File::open(file).ok()?.take(limit)).ok()
}

fn enabled(fork: &Path) -> bool {
    std::fs::symlink_metadata(fork).is_ok_and(|meta| meta.is_dir())
        && read::<serde_json::Value>(&fork.join("enabled.json"), 1024)
            .is_some_and(|value| value["enabled"].as_bool() == Some(true))
}

/// Fixed live projections for the selected native Codex fork.
#[tauri::command]
pub fn fork_reply_draft(id: u8) -> Option<LiveDrafts> {
    if !(2..=8).contains(&id) {
        return None;
    }
    let data_dir = std::env::var_os("MIND_WAKE_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join("mind-wake"))
        })?;
    let forks = data_dir.join("forks");
    let fork = forks.join(id.to_string());
    if !std::fs::symlink_metadata(&forks).ok()?.is_dir() || !enabled(&fork) {
        return None;
    }
    let incoming = (2..=8)
        .filter(|&from| from != id)
        .filter_map(|from| {
            let source = forks.join(from.to_string());
            if !enabled(&source) {
                return None;
            }
            let draft = read::<IncomingDraft>(&source.join("interfil-live.json"), 24_000)?;
            (draft.from == from && draft.to == id).then_some(draft)
        })
        .collect();
    Some(LiveDrafts { reply: read(&fork.join("reply-live.json"), 4096), incoming })
}
