use std::path::{Component, Path};

pub const SERIES_ROOT: &str = "artifacts/projets/mode-series/serie";
/// A local reader selection changes the film, never the production workers.
pub fn selected_root(workspace: &Path) -> Result<String, String> {
    let config = workspace.join("artifacts/series-reader.json");
    if !config.exists() { return Ok(SERIES_ROOT.into()); }
    let real = config.canonicalize().map_err(|e|e.to_string())?;
    if !real.starts_with(workspace) || real.metadata().map_err(|e|e.to_string())?.len() > 65536 { return Err("Sélection du lecteur hors de l’atelier".into()); }
    let text = std::fs::read_to_string(real).map_err(|e|e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e|e.to_string())?;
    let root = value["root"].as_str().ok_or("Racine du lecteur requise")?.replace('\\', "/");
    if !root.starts_with("artifacts/projets/") || Path::new(&root).components().any(|c|!matches!(c,Component::Normal(_))) { return Err("Racine du lecteur hors des projets".into()); }
    Ok(root)
}
fn media_limit(mime: &str) -> u64 {
    if mime.starts_with("video/") { 512 * 1024 * 1024 } else { 32 * 1024 * 1024 }
}
fn media_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "wav" => Some("audio/wav"),
        "mp3" => Some("audio/mpeg"),
        _ => None,
    }
}
pub fn scan(base: &Path, dir: &Path, files: &mut Vec<serde_json::Value>) -> Result<(), String> {
    scan_inner(base, dir, files, &mut std::collections::HashSet::new())
}
fn scan_inner(
    base: &Path,
    dir: &Path,
    files: &mut Vec<serde_json::Value>,
    visited: &mut std::collections::HashSet<std::path::PathBuf>,
) -> Result<(), String> {
    if dir.join("failure.json").is_file() || dir.join(".render-incomplete").is_file() { return Ok(()); }
    if !visited.insert(dir.to_owned()) {
        return Ok(());
    }
    for item in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        // Do not traverse links/junctions, or hidden working directories.
        if item.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let raw = item.path();
        let real = raw.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(base) {
            continue;
        }
        if item.file_type().map_err(|e| e.to_string())?.is_symlink() {
            continue;
        }
        if real.is_dir() {
            scan_inner(base, &real, files, visited)?;
        } else if real.is_file() {
            let metadata = real.metadata().map_err(|e| e.to_string())?;
            files.push(serde_json::json!({"relative":real.strip_prefix(base).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/"),"bytes":metadata.len(),"modifiedAt":metadata.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_millis())}));
        }
    }
    Ok(())
}
pub fn read_at(base: &Path, relative: &str, media: bool) -> Result<serde_json::Value, String> {
    if relative.is_empty()
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Chemin hors de la série".into());
    }
    let target = base
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !target.starts_with(base) || !target.is_file() {
        return Err("Fichier hors de la série".into());
    }
    let len = target.metadata().map_err(|e| e.to_string())?.len();
    if media {
        let mime = media_mime(&target).ok_or("Format média non pris en charge")?;
        if len == 0 || len > media_limit(mime) {
            return Err(format!("Aperçu local : média vide ou supérieur à {} Mo", media_limit(mime) / (1024 * 1024)));
        }
        // Only metadata crosses IPC. The WebView reads ranges via the scoped asset
        // protocol; a Vec<u8> serialized as JSON can exhaust memory for a film.
        return Ok(serde_json::json!({"path":target.to_string_lossy(),"mime":mime,"size":len}));
    }
    let ext = target
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "md" | "markdown" | "txt" | "json" | "jsonl" | "csv" | "srt" | "vtt"
    ) {
        return Err("Aperçu texte indisponible pour ce format".into());
    }
    if len > 2_000_000 {
        return Err("Aperçu texte limité à 2 Mo".into());
    }
    Ok(
        serde_json::json!({"text":std::fs::read_to_string(target).map_err(|e|e.to_string())?,"format":ext}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reader_selection_is_confined_and_legacy_is_preserved() {
        let dir=std::env::temp_dir().join(format!("wake-reader-selection-{}",std::process::id()));
        std::fs::create_dir_all(dir.join("artifacts")).unwrap();
        let base=dir.canonicalize().unwrap();
        assert_eq!(selected_root(&base).unwrap(),SERIES_ROOT);
        let config=base.join("artifacts/series-reader.json");
        std::fs::write(&config,r#"{"root":"artifacts/projets/film-marco/pipeline/serie"}"#).unwrap();
        assert_eq!(selected_root(&base).unwrap(),"artifacts/projets/film-marco/pipeline/serie");
        for root in ["../secret","C:/outside","artifacts/projets/../outside"] {
            std::fs::write(&config,serde_json::json!({"root":root}).to_string()).unwrap();
            assert!(selected_root(&base).is_err());
        }
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn full_episode_video_has_a_distinct_size_budget() {
        assert!(64 * 1024 * 1024 < media_limit("video/mp4"));
        assert!(64 * 1024 * 1024 > media_limit("image/png"));
        assert_eq!(media_limit("audio/wav"), 32 * 1024 * 1024);
    }
    #[test]
    fn large_video_crosses_ipc_as_metadata_only() {
        let dir=std::env::temp_dir().join(format!("wake-series-large-video-{}",std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file=std::fs::File::create(dir.join("film.mp4")).unwrap();
        file.set_len(172_268_338).unwrap();
        let base=dir.canonicalize().unwrap();
        let response=read_at(&base,"film.mp4",true).unwrap();
        assert_eq!(response["size"],172_268_338u64);
        assert!(response.get("bytes").is_none());
        assert!(response["path"].as_str().is_some());
        assert!(response.to_string().len()<1024);
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn confined_inventory_and_reads() {
        let dir = std::env::temp_dir().join(format!("wake-series-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sources")).unwrap();
        std::fs::write(dir.join("sources/fil.jsonl"), "{\"line\":1}\n").unwrap();
        std::fs::write(dir.join("video.mp4"), [0u8, 1, 2]).unwrap();
        std::fs::create_dir_all(dir.join("failed")).unwrap();
        std::fs::write(dir.join("failed/partial.mp4"),[0u8,1,2]).unwrap();
        std::fs::write(dir.join("failed/failure.json"),"{}").unwrap();
        let base = dir.canonicalize().unwrap();
        let mut files = vec![];
        scan(&base, &base, &mut files).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(
            read_at(&base, "sources/fil.jsonl", false).unwrap()["format"],
            "jsonl"
        );
        assert!(read_at(&base, "../outside.md", false).is_err());
        assert!(read_at(&base, "video.mp4", false).is_err());
        assert_eq!(
            read_at(&base, "video.mp4", true).unwrap()["mime"],
            "video/mp4"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn current_series_inventory() {
        let Some(root) = std::env::var_os("SERIES_TEST_ROOT") else {
            return;
        };
        let base = std::path::PathBuf::from(root).canonicalize().unwrap();
        let mut files = vec![];
        scan(&base, &base, &mut files).unwrap();
        assert!(files.iter().any(|v| v["relative"] == "series.json"));
        assert!(files
            .iter()
            .any(|v| v["relative"] == "sources/fil-01.jsonl"));
        assert_eq!(
            read_at(&base, "series.json", false).unwrap()["format"],
            "json"
        );
        println!("{} fichiers réellement inventoriés", files.len());
    }
}
