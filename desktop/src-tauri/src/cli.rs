//! Appel des CLI locales : seul chemin du panneau vers Wake (`mind-wake`) et vers les fils
//! privés de l'humain (`services/mcp/owner-main.ts`). Le panneau n'ouvre ni SQLite, ni
//! port, ni pipe ; il exécute une sous-commande d'une liste fermée avec `--json` et rend
//! la sortie telle quelle. Les permissions restent imposées par la CLI, le hub et le
//! policy engine, pas par cette interface (SPEC §21.4, ADR-007).

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Au-delà, la commande est terminée et le panneau affiche « état indisponible ».
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRun {
    pub exit_code: i32,
    pub stdout: String,
}

/// Sous-commandes `mind-wake` autorisées.
#[derive(Clone, Copy)]
pub enum Verb {
    Status,
    Journal,
    Pause,
    Resume,
    On,
    AlwaysOn,
    Stop,
    Wake,
    Messages,
    WakeHistory,
}

impl Verb {
    fn args(self) -> &'static [&'static str] {
        match self {
            Verb::Status => &["status"],
            Verb::Journal => &["journal", "--limit", "1000"],
            Verb::Pause => &["pause"],
            Verb::Resume => &["resume"],
            Verb::On => &["on"],
            Verb::AlwaysOn => &["always-on"],
            Verb::Stop => &["stop"],
            Verb::Wake => &["wake"],
            Verb::Messages => &["messages"],
            Verb::WakeHistory => &["wake-history"],
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub(crate) fn repo() -> PathBuf {
    env_path("MIND_WAKE_REPO_DIR")
        .unwrap_or_else(|| std::env::current_exe().ok().and_then(|exe|exe.ancestors().find(|p|p.join("dist/cli/main.js").is_file()).map(std::path::Path::to_path_buf)).unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")))
}

/// `MIND_WAKE_NODE` (chemin absolu de node.exe) sinon `node` du PATH.
fn node() -> PathBuf {
    env_path("MIND_WAKE_NODE").unwrap_or_else(|| PathBuf::from("node"))
}

/// `MIND_WAKE_CLI` sinon `dist/cli/main.js` du dépôt. Défaut de développement seulement :
/// le paquet distribué fixera ses chemins (F5).
fn wake_script() -> PathBuf {
    env_path("MIND_WAKE_CLI").unwrap_or_else(|| repo().join("dist/cli/main.js"))
}

/// `MIND_OWNER_CLI` sinon `services/mcp/owner-main.ts`, exécuté depuis les sources comme
/// le hub (type stripping et hooks de résolution du dépôt).
fn owner_command() -> Vec<OsString> {
    let script = env_path("MIND_OWNER_CLI").unwrap_or_else(|| repo().join("services/mcp/owner-main.ts"));
    let hooks = repo().join("test/fixtures/store-ledger/ts-hooks.ts");
    let hooks_url = format!("file:///{}", hooks.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    vec![
        "--disable-warning=ExperimentalWarning".into(),
        "--experimental-transform-types".into(),
        "--import".into(),
        hooks_url.into(),
        script.into(),
    ]
}

/// Réponses des sessions Claude Code / Codex réveillées pour aider l'agent
/// (`services/helpers/helpers-main.ts answers --json`, état dans MIND_WAKE_HELPERS_DIR).
pub fn helpers_answers() -> Result<CliRun, String> {
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/helpers/helpers-main.ts").into());
    args.push("answers".into());
    run(args, None)
}

pub fn elevenlabs(action: String, payload: Option<serde_json::Value>) -> Result<CliRun, String> {
    if !matches!(action.as_str(), "status" | "configure" | "voices" | "pending" | "audio" | "ack" | "generate" | "speak_desktop" | "claim" | "event" | "enable_pending" | "transcribe" | "stt_preflight" | "realtime_transcription_token" | "cancel_transcription" | "configure_transcription" | "voice_mode_state") {
        return Err("Action ElevenLabs inconnue".into());
    }
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/elevenlabs/desktop-main.ts").into());
    let input = serde_json::json!({"action": action, "payload": payload}).to_string();
    run_with_timeout(args, Some(input), Duration::from_secs(75))
}

/// Réglages « Telegram — mon compte » : `services/telegram/user-account-desktop-main.ts`, qui pilote
/// le sidecar Telethon. La saisie (téléphone, code, 2FA, api_id/api_hash) passe par stdin.
pub fn telegram_user(action: String, payload: Option<serde_json::Value>) -> Result<CliRun, String> {
    if !matches!(action.as_str(), "status" | "configure" | "login_phone" | "login_code" | "login_password" | "logout") {
        return Err("Action Telegram inconnue".into());
    }
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/telegram/user-account-desktop-main.ts").into());
    let input = serde_json::json!({"action": action, "payload": payload}).to_string();
    run_with_timeout(args, Some(input), Duration::from_secs(75))
}

/// Réglages « Pont pair-à-pair entre colonies » : `services/pont-p2p/desktop-main.ts`.
/// Seules la clé publique et son empreinte sortent ; la clé privée reste dans `credentials/`.
pub fn pont_p2p(action: String, payload: Option<serde_json::Value>) -> Result<CliRun, String> {
    if !matches!(action.as_str(), "status" | "enable" | "disable" | "set_annuaire" | "add_contact" | "forget" | "resolve_conflict") {
        return Err("Action du pont pair-à-pair inconnue".into());
    }
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/pont-p2p/desktop-main.ts").into());
    let input = serde_json::json!({"action": action, "payload": payload}).to_string();
    run_with_timeout(args, Some(input), Duration::from_secs(30))
}

/// Appel automatique (page Appel) : `services/auto-call/desktop-main.ts`, actions fixes.
/// N'écrit que `auto-call.json` ; le minuteur et la sonnerie restent dans le moteur.
pub fn auto_call(action: String) -> Result<CliRun, String> {
    if !matches!(action.as_str(), "status" | "on" | "off") {
        return Err("Action d'appel automatique inconnue".into());
    }
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/auto-call/desktop-main.ts").into());
    let input = serde_json::json!({"action": action}).to_string();
    run_with_timeout(args, Some(input), Duration::from_secs(30))
}

pub fn fast_reply(action: &str) -> Result<CliRun, String> {
    let verb = match action { "status" => "status", "on" => "on", "off" => "off", _ => return Err("Action réponse rapide inconnue".into()) };
    run(wake_args(&["fast-reply", verb])?, None)
}

/// Erreur affichée dans le panneau : relayée au principal (`mind-wake app-error`, JSON sur stdin).
/// Seuls `screen`, `text` et `at` viennent du webview ; `app` est fixé ici. La CLI masque les secrets.
pub fn app_error(screen: String, text: String, at: Option<String>) -> Result<CliRun, String> {
    let input = serde_json::json!({"app": "desktop", "screen": screen, "text": text, "at": at}).to_string();
    run(wake_args(&["app-error"])?, Some(input))
}

/// Fixed read-only projection. No action/path comes from the webview.
pub fn agent_prompts(request: serde_json::Value) -> Result<CliRun, String> {
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/prompt-editor/desktop-main.ts").into());
    run(args, Some(request.to_string()))
}

pub fn voice_graph() -> Result<CliRun, String> {
    run_with_timeout(vec![repo().join("services/voice-graph/desktop-main.mjs").into()], None, Duration::from_secs(75))
}

pub fn voice_input(action: String, audio: Option<String>) -> Result<CliRun, String> {
    // `vocabulary` / `vocabulary_save` : vocabulaire STT des Réglages (texte JSON dans `audio`).
    if !matches!(action.as_str(), "snapshot" | "transcribe" | "vocabulary" | "vocabulary_save") { return Err("Action vocale inconnue".into()); }
    if audio.as_ref().is_some_and(|value| value.len() > 5_500_000) { return Err("Audio trop volumineux".into()); }
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/voice/desktop-main.mjs").into());
    let input = serde_json::json!({"action": action, "audio": audio}).to_string();
    run_with_timeout(args, Some(input), Duration::from_secs(135))
}

fn wake_args(verb_args: &[&str]) -> Result<Vec<OsString>, String> {
    let script = wake_script();
    if !script.is_file() {
        return Err(format!(
            "CLI introuvable ({}) : lancer `npm run build` ou définir MIND_WAKE_CLI",
            script.display()
        ));
    }
    let mut args: Vec<OsString> = vec![script.into()];
    args.extend(verb_args.iter().map(OsString::from));
    Ok(args)
}

/// Fil principal : seulement les `limit` éléments les plus récents (`messages --limit`).
/// Lecture seule : le statut mis en cache reste valable. Sans limite, tout le fil (≈ 6,8 Mo).
pub fn wake_messages(limit: Option<u32>) -> Result<CliRun, String> {
    let mut args = wake_args(Verb::Messages.args())?;
    if let Some(limit) = limit {
        args.extend(["--limit".into(), limit.clamp(1, 10_000).to_string().into()]);
    }
    // 30 s : la lecture prend ~0,1 s, mais le démarrage de node (≈300 modules ouverts un à un)
    // dépasse 15 s quand la machine est saturée. Le panneau sérialise ses relectures (`busy`).
    run_with_timeout(args, None, Duration::from_secs(30))
}

pub fn wake(verb: Verb) -> Result<CliRun, String> {
    if matches!(verb, Verb::On | Verb::Resume) {
        let status = run(wake_args(Verb::Status.args())?, None)?;
        recover_abandoned_session(&status)?;
    }
    let generation = STATUS.generation();
    let result = run(wake_args(verb.args())?, None);
    match verb {
        Verb::Status => { if let Ok(run) = &result { STATUS.remember(generation, run); } }
        // Toute autre commande peut changer l'état : le prochain lecteur relit.
        _ => STATUS.forget(),
    }
    result
}

/// Dernier `wake status` réussi, partagé entre l'icône et le panneau : un seul processus
/// Node pour les deux au lieu d'un chacun. Les lecteurs simultanés attendent le même appel.
struct StatusCache {
    turn: std::sync::Mutex<()>,
    last: std::sync::Mutex<Option<(Instant, i32, String)>>,
    /// Avancé à chaque changement d'état : une lecture commencée avant n'est pas gardée.
    generation: std::sync::atomic::AtomicU64,
}

static STATUS: StatusCache = StatusCache::new();
/// `forks status` (≈ 0,9 Mo de JSON, un processus Node) : même partage que `STATUS`.
static FORKS: StatusCache = StatusCache::new();

/// Âge maximal d'une lecture d'état partagée. Panneau visible : le panneau relit `status`
/// toutes les 2 s et l'icône toutes les 3 s ; 3,5 s fait servir une lecture sur deux par
/// le cache. Panneau masqué ou réduit : seule l'icône compte, 10 s suffisent. Toute action
/// qui change l'état vide le cache (`forget`), le prochain lecteur relit aussitôt.
pub fn status_max_age(panel_visible: bool) -> Duration {
    if panel_visible { Duration::from_millis(3500) } else { Duration::from_secs(10) }
}
/// Rooms relues toutes les 5 s par le panneau : 4,5 s fusionne les lectures doublées sans
/// retarder le rythme normal ; panneau masqué, 30 s.
pub fn forks_max_age(panel_visible: bool) -> Duration {
    if panel_visible { Duration::from_millis(4500) } else { Duration::from_secs(30) }
}

impl StatusCache {
    const fn new() -> Self {
        StatusCache {
            turn: std::sync::Mutex::new(()),
            last: std::sync::Mutex::new(None),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }
    fn fresh(&self, max_age: Duration) -> Option<CliRun> {
        let last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        last.as_ref()
            .filter(|(at, _, _)| at.elapsed() < max_age)
            .map(|(_, exit_code, stdout)| CliRun { exit_code: *exit_code, stdout: stdout.clone() })
    }
    fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn remember(&self, generation: u64, run: &CliRun) {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if self.generation() == generation {
            *last = Some((Instant::now(), run.exit_code, run.stdout.clone()));
        }
    }
    fn forget(&self) {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *last = None;
    }
    fn get(&self, max_age: Duration, read: impl FnOnce() -> Result<CliRun, String>) -> Result<CliRun, String> {
        if let Some(run) = self.fresh(max_age) { return Ok(run); }
        let _turn = self.turn.lock().unwrap_or_else(|e| e.into_inner());
        // Un autre lecteur a pu relire pendant l'attente.
        if let Some(run) = self.fresh(max_age) { return Ok(run); }
        let generation = self.generation();
        let result = read();
        if let Ok(run) = &result { self.remember(generation, run); }
        result
    }
}

/// `wake status` réutilisé s'il date de moins de `max_age`.
pub fn shared_status(max_age: Duration) -> Result<CliRun, String> {
    STATUS.get(max_age, || wake(Verb::Status))
}

/// Fixed profile-local first welcome. No shell, file name or extra argument from the webview.
pub fn onboarding(start: bool, accept_native: bool) -> Result<CliRun, String> {
    if start && !accept_native { return Err("L’accord pour le mode natif est requis.".into()); }
    let mut args: Vec<OsString> = vec![repo().join("scripts/onboarding.mjs").into(),
        if start { "start" } else { "status" }.into()];
    if start { args.push("--accept-native".into()); }
    run_with_timeout(args, None, Duration::from_secs(90))
}

pub fn wake_order(revision: u64, project_ids: Vec<String>) -> Result<CliRun, String> {
    if project_ids.is_empty() || project_ids.len() > 50 || project_ids.iter().any(|id| id.len() > 128) {
        return Err("Ordre de projets invalide".into());
    }
    let input = serde_json::json!({"revision": revision, "projectIds": project_ids}).to_string();
    run(wake_args(&["wake-order"])? , Some(input))
}

/// Read-only local Git binding; no endpoint or path is accepted from the webview.
pub fn aurore_document(relative: String, read: bool, image: bool, version: Option<String>) -> Result<CliRun, String> {
    let input = serde_json::json!({"relative": relative, "read": read, "image": image, "version": version}).to_string();
    run(vec![repo().join("services/shared-workspace/git-document-reader-main.mjs").into()], Some(input))
}

/// Fixed profile-local operations. Values are separate argv entries, never shell text.
pub fn workspace_sync(action: &str, configuration: Option<(String, String, bool)>) -> Result<CliRun, String> {
    if !matches!(action, "status" | "configure" | "now") {
        return Err("Action de synchronisation inconnue".into());
    }
    let mut args = wake_args(&["workspace-sync", action])?;
    if action == "configure" {
        let (workspace, github, enabled) = configuration.ok_or("Réglages manquants")?;
        if !std::path::Path::new(&workspace).is_absolute() || workspace.contains('\0') || github.contains('\0') {
            return Err("Dossier absolu et URL valides requis".into());
        }
        args.extend(["--workspace".into(), workspace.into(), "--github-url".into(), github.into(),
            "--enabled".into(), if enabled { "true" } else { "false" }.into()]);
    }
    run(args, None)
}

/// Opens only fixed locations resolved by the local Wake CLI, never a webview-supplied path.
pub fn open_wake_location(kind: &str) -> Result<(), String> {
    if kind != "workspace" && kind != "systemPrompt" { return Err("Emplacement inconnu".into()); }
    let history = wake(Verb::WakeHistory)?;
    let envelope: serde_json::Value = serde_json::from_str(&history.stdout).map_err(|e| e.to_string())?;
    if history.exit_code != 0 { return Err("Emplacements de l’agent indisponibles".into()); }
    let file = envelope["data"]["locations"][kind].as_str().ok_or("Prompt système pas encore disponible")?;
    let target = PathBuf::from(file).canonicalize().map_err(|e| e.to_string())?;
    if kind == "workspace" {
        if !target.is_dir() { return Err("Dossier de l’agent introuvable".into()); }
        Command::new("explorer.exe").arg(target).spawn().map_err(|e| e.to_string())?;
    } else {
        if !target.is_file() || target.extension().and_then(|s| s.to_str()) != Some("md") {
            return Err("Fichier du prompt invalide".into());
        }
        Command::new("notepad.exe").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bouton « Réveil » : démarre le daemon s'il ne tourne pas, puis demande la session.
/// Le daemon est détaché du panneau (le fermer ne l'arrête pas) ; sa sortie va dans
/// `daemon.log` du dossier de données.
pub fn wake_now() -> Result<CliRun, String> {
    let status = recover_abandoned_session(&wake(Verb::Status)?)?;
    let running = serde_json::from_str::<serde_json::Value>(&status.stdout)
        .map(|j| j["data"]["daemon"]["state"] == "running")
        .unwrap_or(false);
    let requested = wake(Verb::Wake)?;
    if !running {
        start_daemon(&status.stdout)?;
    }
    Ok(requested)
}

pub fn always_on() -> Result<CliRun, String> {
    let status = recover_abandoned_session(&wake(Verb::Status)?)?;
    let running = serde_json::from_str::<serde_json::Value>(&status.stdout).map(|j| j["data"]["daemon"]["state"] == "running").unwrap_or(false);
    // This command is an explicit user selection in the panel/tray. Revalidate the
    // consented policy through reactivate before clearing an emergency stop.
    if requires_reactivation(&status.stdout) {
        let reactivated = run(wake_args(&["reactivate"])?, None)?;
        if reactivated.exit_code != 0 { return Ok(reactivated); }
    }
    let result = wake(Verb::AlwaysOn)?;
    if result.exit_code == 0 && !running { start_daemon(&status.stdout)?; }
    Ok(result)
}

/// Restart only the engine needed to reconcile its abandoned sessions. The
/// persisted Pause/Force-off controls stay in place until the explicit action.
fn recover_abandoned_session(before: &CliRun) -> Result<CliRun, String> {
    recover_abandoned_session_with(before, start_daemon, || wake(Verb::Status), || {
        std::thread::sleep(Duration::from_millis(300));
    })
}

fn recover_abandoned_session_with(
    before: &CliRun,
    start: impl FnOnce(&str) -> Result<(), String>,
    mut status: impl FnMut() -> Result<CliRun, String>,
    mut wait: impl FnMut(),
) -> Result<CliRun, String> {
    let parse = |r: &CliRun| -> Result<serde_json::Value, String> {
        let value: serde_json::Value = serde_json::from_str(&r.stdout).map_err(|e| e.to_string())?;
        if r.exit_code != 0 || value["ok"] != true {
            return Err("État du moteur indisponible ; reprise non effectuée".into());
        }
        Ok(value)
    };
    let value = parse(before)?;
    if value["data"]["openSessions"].as_u64().unwrap_or(0) == 0
        || value["data"]["daemon"]["state"] == "running" {
        return Ok(CliRun { exit_code: before.exit_code, stdout: before.stdout.clone() });
    }
    start(&before.stdout)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        let current = status()?;
        let value = parse(&current)?;
        if value["data"]["openSessions"] == 0 { return Ok(current); }
        wait();
    }
    Err("Le moteur n’a pas encore réconcilié la session interrompue ; Pause et Force-off restent conservés".into())
}

fn requires_reactivation(status: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(status)
        .map(|j| j["data"]["profile"]["state"] == "stopped" || j["data"]["profile"]["emergencyStopLocked"] == true)
        .unwrap_or(false)
}

fn start_daemon(status_json: &str) -> Result<(), String> {
    let data_dir = serde_json::from_str::<serde_json::Value>(status_json)
        .ok()
        .and_then(|j| j["data"]["dataDir"].as_str().map(PathBuf::from))
        .ok_or("dossier de données inconnu")?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("daemon.log"))
        .map_err(|e| format!("journal du daemon : {e}"))?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(node());
    let manifest = data_dir.join("installation/manifest.json");
    if manifest.is_file() {
        let installation: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let repo = installation["repoDir"].as_str().ok_or("Source installée inconnue")?;
        let hooks = PathBuf::from(repo).join("test/fixtures/store-ledger/ts-hooks.ts");
        let hooks_url = format!("file:///{}", hooks.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
        command.args(["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import"])
            .arg(hooks_url)
            .arg(PathBuf::from(repo).join("scripts/engine-supervisor.mjs"))
            .arg("--manifest").arg(manifest);
    } else { command.args(wake_args(&["daemon", "run"]) ?); }
    command
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("démarrage du daemon : {e}"))
}

/// Explicit desktop action: replace the engine, preserving all profile controls.
/// Dropping the old engine closes its Job Objects and stops its runtime children.
pub fn restart_daemon() -> Result<CliRun, String> {
    static RESTART: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = RESTART.try_lock().map_err(|_| "Redémarrage déjà en cours")?;
    let before = wake(Verb::Status)?;
    let status: serde_json::Value = serde_json::from_str(&before.stdout).map_err(|e| e.to_string())?;
    if before.exit_code != 0 || status["ok"] != true {
        return Err("État du moteur indisponible ; aucun processus arrêté".into());
    }
    if let Some(dir) = status["data"]["dataDir"].as_str() {
        let manifest = PathBuf::from(dir).join("installation/manifest.json");
        if manifest.is_file() {
            let installation: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if let Some(repo) = installation["repoDir"].as_str() {
                let mut owner = Command::new(node());
                let hooks = PathBuf::from(repo).join("test/fixtures/store-ledger/ts-hooks.ts");
                let hooks_url = format!("file:///{}", hooks.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
                owner.args(["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import"])
                    .arg(hooks_url)
                    .arg(PathBuf::from(repo).join("scripts/owned-runtime-control.mjs"))
                    .arg("--manifest").arg(&manifest).args(["--role","daemon","--action","restart"]);
                #[cfg(windows)] { use std::os::windows::process::CommandExt; owner.creation_flags(0x0800_0000); }
                if let Ok(output) = owner.output() {
                    if let Ok(result) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                        if result["owned"] == true {
                            if result["ok"] != true { return Err("Relance refusée par le propriétaire du moteur ; vérifier Pause et Force-off".into()); }
                            return wake(Verb::Status);
                        }
                    }
                }
            }
        }
    }
    let old_pid = status["data"]["daemon"]["pid"].as_u64();
    if status["data"]["daemon"]["state"] == "running" {
        let pid = old_pid.filter(|p| *p > 0 && *p <= u32::MAX as u64).ok_or("PID du moteur invalide")?;
        let started = status["data"]["daemon"]["startedAt"].as_str().ok_or("Date du moteur inconnue")?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", include_str!("restart-engine.ps1")])
                .env("WAKE_RESTART_PID", pid.to_string())
                .env("WAKE_RESTART_STARTED", started)
                .creation_flags(0x0800_0000)
                .output().map_err(|e| format!("Arrêt du moteur : {e}"))?;
            if !output.status.success() {
                return Err(format!("Moteur non redémarré : {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        }
        #[cfg(not(windows))]
        { let _ = (pid, started); return Err("Redémarrage du moteur disponible sous Windows uniquement".into()); }
    }
    start_daemon(&before.stdout)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        let current = wake(Verb::Status)?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&current.stdout) {
            if current.exit_code == 0 && value["data"]["daemon"]["state"] == "running"
                && (value["data"]["daemon"]["pid"].as_u64() != old_pid
                    || value["data"]["daemon"]["startedAt"] != status["data"]["daemon"]["startedAt"]) {
                return Ok(current);
            }
        }
    }
    Err("Le nouveau moteur n’a pas confirmé son démarrage. Consulter daemon.log avant de réessayer.".into())
}

/// Second fil Claude Code : actions fixes. « on » et « ensure » démarrent le worker détaché
/// s'il est activé, arrêté et que le profil le permet ; le texte passe par l'entrée standard.
pub fn wake_coach(action: &str, text: Option<String>) -> Result<CliRun, String> {
    let verb = match action { "duo-status" => "duo-status", "duo-on" => "duo-on", "duo-off" => "duo-off", "status" => "status", "on" => "on", "off" => "off", "send" => "send", _ => return Err("Action coach inconnue".into()) };
    let body = if action == "send" {
        let body = text.ok_or("Message manquant")?;
        if body.trim().is_empty() || body.chars().count() > 4000 { return Err("Message vide ou trop long".into()); }
        Some(body)
    } else { None };
    run(wake_args(&["coach", verb])?, body)
}
/// Fil principal On/Off : actions fixes, aucune donnée venue du webview n'atteint la CLI.
pub fn main_thread(action: &str) -> Result<CliRun, String> {
    let verb = match action { "status" => "status", "on" => "on", "off" => "off", _ => return Err("Action inconnue".into()) };
    let result = run(wake_args(&["main-thread", verb])?, None)?;
    if verb != "status" { STATUS.forget(); }
    Ok(result)
}
pub fn second_thread(action: &str, text: Option<String>) -> Result<CliRun, String> {
    if action == "send" {
        let body = text.ok_or("Message manquant")?;
        if body.trim().is_empty() || body.chars().count() > 4000 { return Err("Message vide ou trop long".into()); }
        return run(wake_args(&["second-thread", "send"])?, Some(body));
    }
    let verb = match action { "status" | "ensure" => "status", "on" => "on", "off" => "off", _ => return Err("Action inconnue".into()) };
    let result = run(wake_args(&["second-thread", verb])?, None)?;
    if matches!(action, "on" | "ensure") && result.exit_code == 0 {
        let data = serde_json::from_str::<serde_json::Value>(&result.stdout).map(|j| j["data"].clone()).unwrap_or_default();
        if data["enabled"] == true && data["running"] == false && data["profile"] == "run" {
            start_second_thread(data["dataDir"].as_str().ok_or("dossier de données inconnu")?)?;
        }
    }
    Ok(result)
}

pub fn wake_forks(action: &str, id: Option<u8>, text: Option<String>, voice_screen_refs: Option<Vec<String>>, max_age: Duration) -> Result<CliRun, String> {
    if action == "status" {
        // Lecture seule : partagée et fusionnée entre lecteurs simultanés (cf. `FORKS`).
        return FORKS.get(max_age, || wake_forks_uncached(action, id, text, voice_screen_refs));
    }
    // on/off/send/ensure peuvent changer l'état (ensure peut démarrer le worker).
    let result = wake_forks_uncached(action, id, text, voice_screen_refs);
    FORKS.forget();
    result
}

fn wake_forks_uncached(action: &str, id: Option<u8>, text: Option<String>, voice_screen_refs: Option<Vec<String>>) -> Result<CliRun, String> {
    let verb = match action { "status" | "ensure" => "status", "on" => "on", "off" => "off", "send" => "send", "rename" => "rename", _ => return Err("Action inconnue".into()) };
    let body = if matches!(action, "on" | "off" | "send" | "rename") {
        let slot = id.filter(|n| (2..=8).contains(n)).ok_or("Fork attendu : 2 à 8")?;
        if action == "send" && text.as_ref().is_none_or(|s| s.trim().is_empty() || s.chars().count() > 4000) { return Err("Message vide ou trop long".into()); }
        // Renommage (nom affiché seulement) : texte vide = nom par défaut ; la CLI valide 2 à 40 caractères.
        if action == "rename" && text.as_ref().is_some_and(|s| s.chars().count() > 40) { return Err("Nom trop long (40 caractères au plus)".into()); }
        let mut body = serde_json::json!({"id":slot,"text":text});
        if let Some(refs) = voice_screen_refs {
            if action != "send" || refs.len() > 3 || refs.iter().any(|r| r.len() > 100) {
                return Err("Planche écran invalide".into());
            }
            body["voice_screen_refs"] = serde_json::json!(refs);
        }
        Some(body.to_string())
    } else { None };
    let result = run(wake_args(&["forks", verb])?, body)?;
    if matches!(action, "on" | "ensure") && result.exit_code == 0 {
        let data = serde_json::from_str::<serde_json::Value>(&result.stdout).map(|j| j["data"].clone()).unwrap_or_default();
        let enabled = data["forks"].as_array().is_some_and(|rows| rows.iter().any(|r| r["enabled"] == true));
        if enabled && data["running"] == false && data["profile"] == "run" {
            start_parallel_worker(data["dataDir"].as_str().ok_or("Dossier de données inconnu")?, "forks", "forks.log")?;
        }
    }
    Ok(result)
}

fn start_second_thread(data_dir: &str) -> Result<(), String> {
    start_parallel_worker(data_dir, "second-thread", "second-thread.log")
}

fn start_parallel_worker(data_dir: &str, worker: &str, log_name: &str) -> Result<(), String> {
    let log = std::fs::OpenOptions::new().create(true).append(true)
        .open(PathBuf::from(data_dir).join(log_name))
        .map_err(|e| format!("journal du second fil : {e}"))?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(node());
    command.args(wake_args(&[worker, "run", "--data-dir", data_dir])?)
        .stdin(Stdio::null()).stdout(log).stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("démarrage du second fil : {e}"))
}

/// Réponse de l'humain à son agent (`mind-wake reply`) : clé vérifiée ici puis par la CLI,
/// texte par l'entrée standard, jamais en argument.
pub fn wake_reply(key: String, text: String, voice_screen_refs: Option<Vec<String>>) -> Result<CliRun, String> {
    if !idempotency_key(&key) {
        return Err("clé d'idempotence invalide".into());
    }
    let mut args = wake_args(&["reply", "--idempotency-key"])?;
    args.push(key.into());
    if let Some(references) = voice_screen_refs.filter(|refs| !refs.is_empty()) {
        if references.len() > 3 || references.iter().any(|reference| reference.len() > 120) {
            return Err("Références des planches écran invalides".into());
        }
        args.extend(["--voice-screen-refs".into(), serde_json::to_string(&references).map_err(|e| e.to_string())?.into()]);
    }
    run(args, Some(text))
}

pub fn broadcast(action: &str, key: Option<String>, text: Option<String>) -> Result<CliRun, String> {
    let verb=match action {"status"=>"broadcast-status","send"=>"broadcast-send",_=>return Err("Action inconnue".into())};
    let mut args=wake_args(&[verb])?;
    if action=="send" { let key=key.ok_or("Clé manquante")?; if !idempotency_key(&key){return Err("Clé invalide".into());} args.extend(["--idempotency-key".into(),key.into()]); }
    run(args,text)
}

/// Fixed recipient alias only. No endpoint or credential is accepted from the webview.
pub fn recipient(action: &str, key: Option<String>, text: Option<String>) -> Result<CliRun, String> {
    let verb = match action { "status" => "recipient-status", "poll" => "recipient-poll", "send" => "recipient-send", _ => return Err("Action inconnue".into()) };
    let mut args=owner_command();
    args.extend([verb.into(),"--json".into()]);
    if action=="send" {
        let key=key.ok_or("Clé manquante")?;
        if !idempotency_key(&key) { return Err("Clé invalide".into()); }
        let body=text.as_ref().ok_or("Message manquant")?;
        if body.trim().is_empty() || body.chars().count()>4000 { return Err("Message invalide".into()); }
        args.extend(["--idempotency-key".into(),key.into()]);
    }
    run(args,text)
}

pub fn quick_reply(key: String, text: String, point: Option<crate::quick_input::ClickTarget>) -> Result<CliRun, String> {
    if !idempotency_key(&key) || text.trim().is_empty() || text.chars().count() > 4000 {
        return Err("Message ou identifiant invalide".into());
    }
    let mut args = wake_args(&["reply", "--capture-screen", "--idempotency-key"])?;
    args.push(key.into());
    run_with_click(args, Some(text), point)
}

/// A quick message never lifts Pause/Force-off. The queue survives until resume.
pub fn wake_after_quick_reply() {
    if let Ok(status) = wake(Verb::Status) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&status.stdout) {
            if matches!(value["data"]["profile"]["state"].as_str(), Some("ready" | "hibernating")) {
                let _ = wake_now();
            }
        }
    }
}

/// Requête vers les fils de l'humain. Les identifiants viennent du webview : formats
/// vérifiés ici, puis de nouveau par la CLI et le hub.
pub enum OwnerRequest {
    Threads,
    Thread { thread_id: String },
    Reply { thread_id: String, in_reply_to: Option<String>, idempotency_key: String, text: String },
}

fn opaque(value: &str, prefix: &str) -> bool {
    let Some(rest) = value.strip_prefix(prefix) else { return false };
    (8..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

pub fn owner(request: OwnerRequest) -> Result<CliRun, String> {
    let mut args = owner_command();
    let mut stdin = None;
    match request {
        OwnerRequest::Threads => args.push("threads".into()),
        OwnerRequest::Thread { thread_id } => {
            if !opaque(&thread_id, "thr_") {
                return Err("identifiant de fil invalide".into());
            }
            args.extend(["thread".into(), "--thread".into(), thread_id.into()]);
        }
        OwnerRequest::Reply { thread_id, in_reply_to, idempotency_key: key, text } => {
            if !opaque(&thread_id, "thr_") || !idempotency_key(&key) {
                return Err("identifiant de fil ou clé d'idempotence invalide".into());
            }
            if in_reply_to.as_deref().is_some_and(|m| !opaque(m, "msg_")) {
                return Err("message cité invalide".into());
            }
            args.extend([
                "reply".into(),
                "--thread".into(),
                thread_id.into(),
                "--idempotency-key".into(),
                key.into(),
            ]);
            if let Some(cited) = in_reply_to {
                args.extend(["--in-reply-to".into(), cited.into()]);
            }
            // Le texte passe par l'entrée standard, jamais en argument.
            stdin = Some(text);
        }
    }
    run(args, stdin)
}

fn run(args: Vec<OsString>, stdin: Option<String>) -> Result<CliRun, String> {
    run_with_click(args, stdin, None)
}


fn run_with_click(args: Vec<OsString>, stdin: Option<String>, point: Option<crate::quick_input::ClickTarget>) -> Result<CliRun, String> {
    run_with_options(args, stdin, point, TIMEOUT)
}

fn run_with_timeout(args: Vec<OsString>, stdin: Option<String>, timeout: Duration) -> Result<CliRun, String> {
    run_with_options(args, stdin, None, timeout)
}

fn run_with_options(mut args: Vec<OsString>, stdin: Option<String>, point: Option<crate::quick_input::ClickTarget>, timeout: Duration) -> Result<CliRun, String> {
    args.push("--json".into());
    let mut command = Command::new(node());
    command.env_remove("MIND_WAKE_CAPTURE_CLICK_X").env_remove("MIND_WAKE_CAPTURE_CLICK_Y");
    command.env_remove("MIND_WAKE_CAPTURE_CLICK_AT_MS").env_remove("MIND_WAKE_CAPTURE_CLICK_ROOT");
    if let Some(point) = point {
        command.env("MIND_WAKE_CAPTURE_CLICK_X", point.x.to_string()).env("MIND_WAKE_CAPTURE_CLICK_Y", point.y.to_string());
        if args.iter().any(|arg| arg.to_string_lossy().starts_with("ui-bumpe-")) {
            command.env("MIND_WAKE_CAPTURE_CLICK_AT_MS",point.at_ms.to_string()).env("MIND_WAKE_CAPTURE_CLICK_ROOT",point.root_window.to_string());
        }
    }
    command
        .args(&args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        // stderr est lu pour le diagnostic : sans lui, un abort de node (code 134) ne dit rien.
        .stderr(Stdio::piped());
    // MIND_WAKE_DATA_DIR, MIND_MCP_HUB_PIPE et MIND_MCP_LINK_KEY sont hérités tels quels.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("impossible de lancer node : {e}"))?;
    if let Some(text) = stdin {
        let mut pipe = child.stdin.take().ok_or("entrée de la CLI indisponible")?;
        pipe.write_all(text.as_bytes()).map_err(|e| format!("écriture impossible : {e}"))?;
    }
    let mut stdout = child.stdout.take().ok_or("sortie de la CLI indisponible")?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        stdout.read_to_string(&mut out).map(|_| out)
    });
    let mut stderr = child.stderr.take().ok_or("erreurs de la CLI indisponibles")?;
    let errors = std::thread::spawn(move || {
        let mut raw = Vec::new();
        let _ = stderr.read_to_end(&mut raw);
        raw
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("la CLI n'a pas répondu en {} s", timeout.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let stdout = reader
        .join()
        .map_err(|_| "lecture de la sortie interrompue".to_string())?
        .map_err(|e| format!("sortie illisible : {e}"))?;
    let errors = errors.join().unwrap_or_default();
    if stdout.trim().is_empty() {
        let tail = stderr_tail(&errors);
        let detail = if tail.is_empty() { String::new() } else { format!(" : {tail}") };
        return Err(format!("la CLI n'a rien renvoyé (code {:?}){detail}", status.code()));
    }
    Ok(CliRun { exit_code: status.code().unwrap_or(-1), stdout })
}

/// Dernières lignes utiles de stderr (sans avertissements expérimentaux), bornées à 400 caractères.
fn stderr_tail(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let lines: Vec<&str> = text.lines().map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains("ExperimentalWarning") && !l.starts_with("(Use `node --trace-warnings"))
        .collect();
    let joined = lines[lines.len().saturating_sub(4)..].join(" | ");
    let chars: Vec<char> = joined.chars().collect();
    if chars.len() > 400 { format!("…{}", chars[chars.len() - 400..].iter().collect::<String>()) } else { joined }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_tail_keeps_the_fatal_lines() {
        let raw = b"(node:1) ExperimentalWarning: SQLite

<--- Last few GCs --->
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
";
        assert_eq!(stderr_tail(raw), "<--- Last few GCs ---> | FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
        assert_eq!(stderr_tail(b""), "");
        assert!(stderr_tail("é".repeat(1000).as_bytes()).chars().count() <= 401);
    }

    fn cache() -> StatusCache { StatusCache::new() }
    fn status(stdout: &str) -> Result<CliRun, String> { Ok(CliRun { exit_code: 0, stdout: stdout.into() }) }

    #[test]
    fn simultaneous_readers_share_one_spawn() {
        let c = std::sync::Arc::new(cache());
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..6).map(|_| {
            let (c, reads) = (c.clone(), reads.clone());
            std::thread::spawn(move || c.get(Duration::from_secs(5), || {
                reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(100));
                status("forks")
            }).unwrap().stdout)
        }).collect();
        for t in threads { assert_eq!(t.join().unwrap(), "forks"); }
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// Spawns par minute avec le rythme réel du panneau (status 2 s + icône 3 s, Rooms 5 s
    /// lues deux fois) : simulation sur une horloge fictive de la règle « relire si âge ≥ max ».
    fn spawns_per_minute(periods_ms: &[u64], max_age: Duration) -> usize {
        let mut events: Vec<u64> = periods_ms.iter().flat_map(|p| (0..60_000).step_by(*p as usize)).collect();
        events.sort_unstable();
        let mut last: Option<u64> = None;
        events.into_iter().filter(|t| {
            let stale = last.is_none_or(|l| t - l >= max_age.as_millis() as u64);
            if stale { last = Some(*t); }
            stale
        }).count()
    }

    #[test]
    fn polling_budget_with_visible_and_hidden_panel() {
        // Avant : status 1,5 s (panneau) — chaque tick du panneau relançait Node.
        assert_eq!(spawns_per_minute(&[2000, 3000], Duration::from_millis(1500)), 30);
        assert_eq!(spawns_per_minute(&[2000, 3000], status_max_age(true)), 15);
        assert_eq!(spawns_per_minute(&[2000, 3000], status_max_age(false)), 6);
        // Rooms : deux lecteurs à 5 s, avant sans cache = 24/min.
        assert_eq!(spawns_per_minute(&[5000, 5000], forks_max_age(true)), 12);
        assert_eq!(spawns_per_minute(&[5000, 5000], forks_max_age(false)), 2);
    }

    #[test]
    fn shared_status_reuses_a_fresh_read_and_rereads_after_a_change() {
        let c = cache();
        let mut reads = 0;
        assert_eq!(c.get(Duration::from_secs(5), || { reads += 1; status("a") }).unwrap().stdout, "a");
        assert_eq!(c.get(Duration::from_secs(5), || { reads += 1; status("b") }).unwrap().stdout, "a");
        assert_eq!(reads, 1);
        c.forget();
        assert_eq!(c.get(Duration::from_secs(5), || { reads += 1; status("c") }).unwrap().stdout, "c");
        assert_eq!(c.get(Duration::ZERO, || { reads += 1; status("d") }).unwrap().stdout, "d");
        assert_eq!(reads, 3);
    }

    #[test]
    fn shared_status_drops_a_read_that_started_before_a_change() {
        let c = cache();
        let _ = c.get(Duration::from_secs(5), || { c.forget(); status("stale") });
        let mut reads = 0;
        assert_eq!(c.get(Duration::from_secs(5), || { reads += 1; status("new") }).unwrap().stdout, "new");
        assert_eq!(reads, 1);
    }

    fn recovery_status(daemon: &str, open: u64) -> CliRun {
        CliRun { exit_code: 0, stdout: serde_json::json!({
            "ok": true, "data": {"daemon": {"state": daemon}, "openSessions": open,
            "profile": {"state": "stopped", "emergencyStopLocked": true}}
        }).to_string() }
    }

    #[test]
    fn reconciles_before_reactivation_without_clearing_force_off() {
        let mut polls = 0;
        let recovered = recover_abandoned_session_with(&recovery_status("crashed", 1),
            |status| { assert!(requires_reactivation(status)); Ok(()) },
            || { polls += 1; Ok(recovery_status("running", if polls == 1 {1} else {0})) },
            || {}).unwrap();
        assert_eq!(polls, 2);
        assert!(requires_reactivation(&recovered.stdout));
    }

    #[test]
    fn leaves_live_sessions_and_clean_stops_alone() {
        for before in [recovery_status("running", 1), recovery_status("crashed", 0)] {
            recover_abandoned_session_with(&before,
                |_| panic!("must not start another engine"),
                || panic!("must not poll"), || {}).unwrap();
        }
    }

    #[test]
    fn failed_recovery_never_proceeds_to_activation() {
        let result = recover_abandoned_session_with(&recovery_status("crashed", 1),
            |_| Err("engine unavailable".into()), || panic!("must not poll"), || {});
        assert!(result.is_err());
    }

    #[test]
    fn explicit_always_on_reactivates_only_a_stopped_or_locked_profile() {
        assert!(requires_reactivation(r#"{"data":{"profile":{"state":"stopped","emergencyStopLocked":true}}}"#));
        assert!(requires_reactivation(r#"{"data":{"profile":{"state":"ready","emergencyStopLocked":true}}}"#));
        assert!(!requires_reactivation(r#"{"data":{"profile":{"state":"paused","emergencyStopLocked":false}}}"#));
        assert!(!requires_reactivation("invalid"));
    }

    #[test]
    fn formats_d_identifiants() {
        assert!(opaque("thr_abcdEFGH12", "thr_"));
        assert!(!opaque("thr_abc", "thr_"));
        assert!(!opaque("msg_abcdefgh12", "thr_"));
        assert!(!opaque("thr_abcdefgh;rm", "thr_"));
        assert!(idempotency_key("ui-1234-abcd"));
        assert!(!idempotency_key("court"));
        assert!(!idempotency_key("ui 1234 abcd"));
    }

    #[test]
    fn reponse_refusee_avant_tout_lancement() {
        let refused = owner(OwnerRequest::Reply {
            thread_id: "thr_bad id!!".into(),
            in_reply_to: None,
            idempotency_key: "ui-12345678".into(),
            text: "x".into(),
        });
        assert!(refused.is_err());
    }
}
