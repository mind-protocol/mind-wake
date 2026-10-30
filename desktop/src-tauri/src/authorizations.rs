use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::Write, path::PathBuf, sync::Mutex};

static SAVING: Mutex<()> = Mutex::new(());

fn file() -> Result<PathBuf, String> {
    let run = crate::cli::wake(crate::cli::Verb::WakeHistory)?;
    let value: Value = serde_json::from_str(&run.stdout).map_err(|e| e.to_string())?;
    if run.exit_code != 0 { return Err("Espace de l'agent indisponible".into()); }
    let base = PathBuf::from(value["data"]["locations"]["workspace"].as_str().ok_or("Espace de l'agent indisponible")?)
        .canonicalize().map_err(|e| e.to_string())?;
    let target = base.join("AUTORISATIONS.json");
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1_000_000 || !target.canonicalize().map_err(|e| e.to_string())?.starts_with(&base) {
            return Err("Fichier d'autorisations invalide".into());
        }
    }
    Ok(target)
}

fn validate(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("Document invalide")?;
    if object.len() != 6 || value["version"] != 1 || !["title", "context", "example", "guidance"].iter().all(|k| value[k].is_string()) { return Err("Format d'autorisations invalide".into()); }
    let entries = value["entries"].as_array().ok_or("Liste d'autorisations absente")?;
    let mut ids = HashSet::new();
    for entry in entries {
        if entry.as_object().map(|o| o.len()) != Some(5)
            || !["id", "action", "scope"].iter().all(|k| entry[k].as_str().is_some_and(|s| !s.trim().is_empty()))
            || !matches!(entry["decision"].as_str(), Some("authorized" | "encouraged" | "discouraged" | "forbidden"))
            || !matches!(entry["category"].as_str(), Some("prepare" | "find_out" | "build" | "fix" | "check" | "tend" | "connect" | "reflect"))
            || !ids.insert(entry["id"].as_str().unwrap_or_default()) {
            return Err("Entrée invalide ou identifiant dupliqué".into());
        }
    }
    Ok(())
}

fn read(file: &PathBuf) -> Result<Option<String>, String> {
    match fs::read_to_string(file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn authorizations_read() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let file = file()?;
        let text = read(&file)?;
        let document = text.as_ref().map(|t| serde_json::from_str::<Value>(t).map_err(|e| e.to_string())).transpose()?;
        if let Some(ref value) = document { validate(value)?; }
        Ok(json!({"document":document,"revision":text,"file":file.to_string_lossy()}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn authorizations_save(document: Value, revision: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = SAVING.lock().map_err(|e| e.to_string())?;
        validate(&document)?;
        let file = file()?;
        if read(&file)? != revision { return Err("Le fichier a changé ailleurs. Recharge les choix avant d'enregistrer.".into()); }
        let text = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())? + "\n";
        if text.len() > 1_000_000 { return Err("Document trop volumineux".into()); }
        let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        let result = (|| {
            output.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            drop(output);
            fs::rename(&temporary, &file).map_err(|e| e.to_string())
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result?;
        Ok(json!({"revision":text}))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn validates_owner_choices_and_rejects_ambiguous_entries() {
        let mut value: Value = serde_json::from_str(include_str!("../../../AUTORISATIONS.json")).unwrap();
        assert!(validate(&value).is_ok());
        value["entries"][0]["decision"] = json!("yes");
        assert!(validate(&value).is_err());
        value["entries"][0]["decision"] = json!("forbidden");
        value["entries"][1]["id"] = value["entries"][0]["id"].clone();
        assert!(validate(&value).is_err());
    }
}
