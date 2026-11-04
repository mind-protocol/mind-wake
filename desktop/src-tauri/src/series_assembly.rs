use crate::series_assembly_data::{read_at, scan, selected_root};
use tauri::Manager;
#[tauri::command]
pub async fn series_assembly(
    app: tauri::AppHandle,
    operation: String,
    relative: Option<String>,
    event: Option<String>,
    details: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = crate::documents::root("agent")?;
        let series_root = selected_root(&workspace)?;
        let candidate = workspace.join(&series_root);
        if !candidate.exists() {
            return Ok(serde_json::json!({"state":"missing","files":[]}));
        }
        let base = candidate.canonicalize().map_err(|e| e.to_string())?;
        if !base.starts_with(&workspace) {
            return Err("Dossier série hors de l’atelier".into());
        }
        match operation.as_str() {
            "inventory" => {
                let mut files = Vec::new();
                scan(&base, &base, &mut files)?;
                files.sort_by_key(|v| v["relative"].as_str().unwrap_or("").to_owned());
                let publication_path = base.join("montage/lecteur.json");
                let publication = publication_path.canonicalize().ok().filter(|p|p.starts_with(&base)).and_then(|p| { if p.metadata().ok()?.len()>65536 { return None; } let text=std::fs::read_to_string(p).ok()?;serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).ok() });
                let request_path=base.join("appui-interface/reader-request.json");
                let reader_request=request_path.canonicalize().ok().filter(|p|p.starts_with(&base)).and_then(|p|{if p.metadata().ok()?.len()>65536{return None;} let text=std::fs::read_to_string(p).ok()?;serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).ok()});
                let project = read_at(&base, "series.json", false).ok().and_then(|v|serde_json::from_str::<serde_json::Value>(v["text"].as_str()?).ok());
                Ok(serde_json::json!({"state":"available","root":series_root,"project":project,"files":files,"publication":publication,"readerRequest":reader_request}))
            }
            "text" | "media" => {
                let data = read_at(&base, relative.as_deref().ok_or("Fichier requis")?, operation == "media")?;
                if operation == "media" {
                    // Grant only the canonical file validated inside the selected series.
                    app.asset_protocol_scope().allow_file(data["path"].as_str().ok_or("Chemin média requis")?).map_err(|e|e.to_string())?;
                }
                Ok(data)
            },
            "receipt" => {
                use std::io::Write;
                let relative = relative.as_deref().ok_or("Fichier requis")?;
                // Validate that the event refers to an actual confined media file.
                let target = base.join(relative).canonicalize().map_err(|e|e.to_string())?;
                if !target.starts_with(&base) || !target.is_file() { return Err("Média hors de la série".into()); }
                let event = event.as_deref().ok_or("Événement requis")?;
                if !matches!(event,"loadedmetadata"|"playing"|"ended"|"error"|"mounted"|"inventory-error"|"frontend-error"|"update-ready"|"version-switch"|"document-loaded") { return Err("Événement inconnu".into()); }
                let folder = base.join("appui-interface");
                std::fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
                let folder = folder.canonicalize().map_err(|e|e.to_string())?;
                if !folder.starts_with(&base) { return Err("Reçu hors de la série".into()); }
                let receipt = folder.join("player-events.jsonl");
                if receipt.exists() && !receipt.canonicalize().map_err(|e|e.to_string())?.starts_with(&base) { return Err("Reçu hors de la série".into()); }
                let details = details.unwrap_or(serde_json::Value::Null);
                let payload = serde_json::json!({"atMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_millis(),"pid":std::process::id(),"event":event,"relative":relative,"duration":details["duration"],"width":details["width"],"height":details["height"],"currentTime":details["currentTime"],"readyState":details["readyState"],"errorCode":details["errorCode"],"version":details["version"],"publicationVersion":details["publicationVersion"],"currentVersion":details["currentVersion"],"playing":details["playing"],"pausedMidway":details["pausedMidway"],"characters":details["characters"],"panelVisible":details["panelVisible"],"documentHidden":details["documentHidden"],"message":details["message"].as_str().unwrap_or("").chars().take(300).collect::<String>()});
                let mut file = std::fs::OpenOptions::new().create(true).append(true).open(receipt).map_err(|e|e.to_string())?;
                writeln!(file,"{}",payload).map_err(|e|e.to_string())?;
                Ok(serde_json::json!({"recorded":true}))
            }
            _ => Err("Opération série inconnue".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
