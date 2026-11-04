//! Installation-local paths survive a direct launch of a binary built in a staging snapshot.
use std::path::{Path, PathBuf};
fn nonempty_env(name: &str) -> bool { std::env::var_os(name).is_some_and(|v| !v.is_empty()) }
fn set_missing(name: &str, value: &Path) { if !nonempty_env(name) && value.is_absolute() { std::env::set_var(name,value); } }
fn resolve_repo(exe: &Path, config: Option<&serde_json::Value>) -> Option<PathBuf> {
    let configured_repo=config.and_then(|v|v["repoDir"].as_str()).map(PathBuf::from);
    configured_repo.filter(|p|p.is_absolute()&&p.join("dist/cli/main.js").is_file()).or_else(||exe.ancestors().find(|p|p.join("dist/cli/main.js").is_file()&&p.join("services/mcp/owner-main.ts").is_file()).map(Path::to_path_buf))
}
pub fn load() {
    let Ok(exe)=std::env::current_exe() else { return; };
    let sidecar=exe.with_extension("runtime.json");
    let config=std::fs::read_to_string(sidecar).ok().and_then(|s|serde_json::from_str::<serde_json::Value>(&s).ok());
    let repo=resolve_repo(&exe,config.as_ref());
    if let Some(repo)=repo {
        set_missing("MIND_WAKE_REPO_DIR",&repo);
        set_missing("MIND_WAKE_CLI",&repo.join("dist/cli/main.js"));
        set_missing("MIND_OWNER_CLI",&repo.join("services/mcp/owner-main.ts"));
    }
    if let Some(config)=config {
        if let Some(data)=config["dataDir"].as_str() { set_missing("MIND_WAKE_DATA_DIR",Path::new(data)); }
        if let Some(node)=config["node"].as_str() { let p=Path::new(node);if p.is_file(){set_missing("MIND_WAKE_NODE",p);} }
    }
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn staged_build_resolves_real_executable_repository() {
  let root=std::env::temp_dir().join(format!("wake-runtime-paths-{}",std::process::id()));
  std::fs::create_dir_all(root.join("dist/cli")).unwrap();std::fs::create_dir_all(root.join("services/mcp")).unwrap();
  std::fs::write(root.join("dist/cli/main.js"),"// cli").unwrap();std::fs::write(root.join("services/mcp/owner-main.ts"),"// owner").unwrap();
  let exe=root.join("desktop/src-tauri/target/release/mind-wake-desktop.exe");
  assert_eq!(resolve_repo(&exe,None),Some(root.clone()));
  let invalid=serde_json::json!({"repoDir":root.join("missing")});
  assert_eq!(resolve_repo(&exe,Some(&invalid)),Some(root.clone()));std::fs::remove_dir_all(root).unwrap();
 }
}
