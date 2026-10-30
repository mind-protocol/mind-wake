use std::path::{Component, Path, PathBuf};

fn root(scope: &str) -> Result<PathBuf, String> {
    let path = match scope {
        "project" => std::env::var_os("MIND_WAKE_REPO_DIR").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        "agent" => {
            let run = crate::cli::wake(crate::cli::Verb::WakeHistory)?;
            let value: serde_json::Value = serde_json::from_str(&run.stdout).map_err(|e| e.to_string())?;
            if run.exit_code != 0 { return Err("Espace agent indisponible".into()); }
            PathBuf::from(value["data"]["locations"]["workspace"].as_str().ok_or("Espace agent indisponible")?)
        }
        _ => return Err("Espace inconnu".into()),
    };
    path.canonicalize().map_err(|e| e.to_string())
}

fn supported(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("md" | "markdown" | "html" | "htm"))
}

#[tauri::command]
pub async fn conversation_image(reference: String, scope: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = match scope {
            Some(scope) => vec![root(&scope)?],
            None => ["agent", "project"].iter().filter_map(|scope| root(scope).ok()).collect(),
        };
        let data_url = crate::conversation_images::read_confined(&reference, &roots)?;
        Ok(serde_json::json!({"dataUrl": data_url}))
    }).await.map_err(|e| e.to_string())?
}

fn resolve(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if Path::new(relative).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("Chemin hors de l’espace".into());
    }
    let target = base.join(relative).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(base) { return Err("Chemin hors de l’espace".into()); }
    Ok(target)
}

#[tauri::command]
pub async fn document_browse(scope: String, relative: String, read: bool, recursive: Option<bool>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = root(&scope)?;
        let target = resolve(&base, &relative)?;
        if read {
            if !supported(&target) || !target.is_file() { return Err("Choisir un fichier HTML ou Markdown".into()); }
            if target.metadata().map_err(|e| e.to_string())?.len() > 2_000_000 { return Err("Document trop volumineux (maximum 2 Mo)".into()); }
            let text = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
            return Ok(serde_json::json!({"text": text, "format": if matches!(target.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("md" | "markdown")) { "markdown" } else { "html" }}));
        }
        if recursive.unwrap_or(false) {
            return catalog(&base, &target);
        }
        let mut entries = Vec::new();
        for item in std::fs::read_dir(target).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build") { continue; }
            let Ok(real) = item.path().canonicalize() else { continue; };
            if !real.starts_with(&base) { continue; }
            let directory = real.is_dir();
            if directory || supported(&real) {
                entries.push(serde_json::json!({"name": name, "directory": directory, "relative": Path::new(&relative).join(item.file_name()).to_string_lossy().replace('\\', "/")}));
            }
        }
        entries.sort_by_key(|e| (e["directory"] != true, e["name"].as_str().unwrap_or_default().to_lowercase()));
        Ok(serde_json::json!({"entries": entries}))
    }).await.map_err(|e| e.to_string())?
}

// One confined read of the library, rather than a CLI round trip per folder.
fn catalog(base: &Path, start: &Path) -> Result<serde_json::Value, String> {
    let mut pending = vec![start.to_path_buf()];
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    let mut truncated = false;
    while let Some(folder) = pending.pop() {
        if !seen.insert(folder.clone()) { continue; }
        if seen.len() > 10_000 { truncated = true; break; }
        let Ok(items) = std::fs::read_dir(&folder) else { continue; };
        for item in items.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | "jobs") { continue; }
            // Do not follow aliases into private/ignored trees or create loops.
            if item.file_type().map(|kind| kind.is_symlink()).unwrap_or(true) { continue; }
            let Ok(real) = item.path().canonicalize() else { continue; };
            if !real.starts_with(base) { continue; }
            if real.is_dir() { pending.push(real); continue; }
            if !real.is_file() || !supported(&real) { continue; }
            let Ok(relative) = real.strip_prefix(base) else { continue; };
            let modified = real.metadata().ok().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t| t.as_millis() as u64).unwrap_or(0);
            entries.push(serde_json::json!({"name":name,"relative":relative.to_string_lossy().replace('\\', "/"),"modifiedAt":modified,"directory":false}));
            if entries.len() >= 10_000 { truncated = true; break; }
        }
        if truncated { break; }
    }
    entries.sort_by(|a,b| b["modifiedAt"].as_u64().cmp(&a["modifiedAt"].as_u64()).then(a["relative"].as_str().cmp(&b["relative"].as_str())));
    Ok(serde_json::json!({"entries":entries,"truncated":truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escape_and_non_document_extensions() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap();
        assert!(resolve(&base, "../Cargo.toml").is_err());
        assert!(resolve(&base, "C:\\Windows\\win.ini").is_err());
        assert!(supported(Path::new("notes.MD")));
        assert!(!supported(Path::new("keys.json")));
    }
    #[test]
    fn catalog_lists_nested_documents_and_omits_hidden_and_build_trees() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("wake-document-catalog-{unique}"));
        for name in ["creations/blog", ".private", "node_modules"] { std::fs::create_dir_all(dir.join(name)).unwrap(); }
        for name in ["creations/blog/index.html", "notes.md", ".private/secret.md", "node_modules/readme.md", "credentials.json"] { std::fs::write(dir.join(name), "sample").unwrap(); }
        let base = dir.canonicalize().unwrap();
        let result = catalog(&base, &base).unwrap();
        let files: Vec<_> = result["entries"].as_array().unwrap().iter().map(|e| e["relative"].as_str().unwrap()).collect();
        assert_eq!(files.len(), 2);
        assert!(files.contains(&"notes.md"));
        assert!(files.contains(&"creations/blog/index.html"));
        assert_eq!(result["truncated"], false);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
