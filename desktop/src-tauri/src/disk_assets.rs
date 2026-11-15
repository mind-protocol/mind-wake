//! Interface lue sur le disque : `desktop/ui` du dépôt est servi à la place de la copie
//! intégrée au binaire. Une modification d'interface demande alors seulement
//! `npm run desktop:ui` puis un rechargement de la fenêtre, sans `cargo build`.
//! L'origine reste `tauri://localhost` : commandes, autorisations et CSP inchangées.
//! Fichier absent du disque (ou dépôt introuvable) : la copie intégrée sert de secours.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Runtime};

/// `MIND_WAKE_DESKTOP_EMBEDDED_UI=1` force la copie intégrée (installation figée).
pub const EMBEDDED_UI_ENV: &str = "MIND_WAKE_DESKTOP_EMBEDDED_UI";

pub struct DiskAssets<R: Runtime> {
    root: PathBuf,
    fallback: Box<dyn Assets<R>>,
}

/// Dossier de l'interface à servir, si le dépôt en contient une utilisable.
pub fn ui_root(repo: &Path, embedded_only: bool) -> Option<PathBuf> {
    if embedded_only {
        return None;
    }
    let root = repo.join("desktop").join("ui");
    root.join("index.html").is_file().then_some(root)
}

/// Chemin sous `root` pour une clé d'asset ; refuse toute sortie du dossier.
pub fn asset_path(root: &Path, key: &str) -> Option<PathBuf> {
    let relative = key.trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

/// Marque écrite par `npm run desktop:ui` après compilation : l'app ouverte se recharge.
pub const RELOAD_STAMP: &str = ".reload-stamp";

/// Recharge les fenêtres quand l'interface vient d'être recompilée (sans cargo, sans relance).
pub fn watch_reload(app: tauri::AppHandle, root: PathBuf) {
    let stamp = root.join("build").join(RELOAD_STAMP);
    let modified = move || std::fs::metadata(&stamp).and_then(|m| m.modified()).ok();
    std::thread::spawn(move || {
        let mut seen = modified();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let now = modified();
            if now.is_some() && now != seen {
                seen = now;
                use tauri::Manager;
                for window in app.webview_windows().values() {
                    let _ = window.eval("location.reload()");
                }
            }
        }
    });
}

/// Fournisseur vide, le temps d'échanger les assets intégrés contre ceux du disque.
pub struct NoAssets;

impl<R: Runtime> Assets<R> for NoAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

impl<R: Runtime> DiskAssets<R> {
    pub fn new(root: PathBuf, fallback: Box<dyn Assets<R>>) -> Self {
        Self { root, fallback }
    }
}

impl<R: Runtime> Assets<R> for DiskAssets<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        asset_path(&self.root, key.as_ref())
            .and_then(|path| std::fs::read(path).ok())
            .map(Cow::Owned)
            .or_else(|| self.fallback.get(key))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.fallback.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // La CSP n'autorise que des scripts en fichiers ('self') : pas d'empreinte propre au disque.
        self.fallback.csp_hashes(html_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_keys_inside_the_ui_folder_only() {
        let root = Path::new("C:/repo/desktop/ui");
        assert_eq!(asset_path(root, "/"), Some(root.join("index.html")));
        assert_eq!(asset_path(root, "/build/main.js"), Some(root.join("build").join("main.js")));
        for escape in ["/../secret.txt", "/build/../../x", "/a//b", "/C:/x", "/a\\..\\b", "/./x"] {
            assert_eq!(asset_path(root, escape), None, "{escape}");
        }
    }

    #[test]
    fn uses_the_disk_ui_only_when_present_and_not_forced_off() {
        let repo = std::env::temp_dir().join(format!("disk-assets-{}", std::process::id()));
        let ui = repo.join("desktop").join("ui");
        std::fs::create_dir_all(&ui).unwrap();
        assert_eq!(ui_root(&repo, false), None);
        std::fs::write(ui.join("index.html"), "<!doctype html>").unwrap();
        assert_eq!(ui_root(&repo, false), Some(ui.clone()));
        assert_eq!(ui_root(&repo, true), None);
        std::fs::remove_dir_all(&repo).unwrap();
    }
}
