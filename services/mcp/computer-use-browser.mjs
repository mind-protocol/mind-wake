#!/usr/bin/env node
/**
 * Navigateur dédié de l'outil MCP `computer_use` (mandat NLR du 16 nov. 2026, 14:59).
 *
 * Le Computer Use de Codex (helper `codex-computer-use.exe`) refuse d'agir dans un navigateur
 * dont il ne lit pas l'URL avec certitude (barre d'adresse en cours d'édition, about:blank) :
 * « could not determine the current browser URL on Windows with enough confidence to enforce
 * policy ». On n'ouvre donc jamais une URL en tapant dans la barre d'adresse : ce script lance
 * un Chrome à profil isolé (jamais celui de NLR, aucun compte connecté), directement sur l'URL,
 * avec un port CDP local qui sert aussi de preuve (titre, URL, capture même si la fenêtre est
 * recouverte).
 *
 *   node computer-use-browser.mjs open <url>                 nouvelle fenêtre sur <url>
 *   node computer-use-browser.mjs list                       onglets : titre + URL (JSON)
 *   node computer-use-browser.mjs shot <fichier.png> [motif] capture de l'onglet dont l'URL
 *                                                            ou le titre contient <motif>
 *
 * Variables : MIND_WAKE_CU_PROFILE (profil isolé), MIND_WAKE_CU_PORT (9333), MIND_WAKE_CU_CHROME.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.MIND_WAKE_CU_PORT || 9333);
const PROFILE =
  process.env.MIND_WAKE_CU_PROFILE ||
  path.join(os.homedir(), "AppData", "Local", "mind-wake-essai", "workspace", "artifacts", "computer-use", "chrome-profile");

function chromePath() {
  const explicit = process.env.MIND_WAKE_CU_CHROME;
  if (explicit) return explicit;
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? "chrome";
}

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tabs() {
  const r = await fetch(`${base}/json/list`);
  return (await r.json()).filter((t) => t.type === "page");
}

async function alive() {
  try {
    await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

function checkUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw Error(`URL http(s) attendue : ${url}`);
  return u.href;
}

/**
 * Lance Chrome sans lui transmettre nos handles. Avec `spawn` direct, Chrome héritait du pipe de
 * sortie du shell de Codex et `codex exec` ne se terminait qu'à la fermeture de Chrome. Sous
 * Windows on passe donc par `Start-Process` (ShellExecute, sans héritage de handles).
 */
function launchChrome(args) {
  if (process.platform !== "win32") {
    spawn(chromePath(), args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const list = args.map((a) => quote(a.includes(" ") ? `"${a}"` : a)).join(",");
  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath ${quote(chromePath())} -ArgumentList ${list}`],
    { stdio: "ignore", windowsHide: true },
  );
  return new Promise((res) => ps.on("close", res));
}

async function open(url) {
  const href = checkUrl(url);
  fs.mkdirSync(PROFILE, { recursive: true });
  if (await alive()) {
    // Chrome isolé déjà lancé : nouvelle fenêtre par CDP, aucun processus créé.
    const v = await (await fetch(`${base}/json/version`)).json();
    await cdp(v.webSocketDebuggerUrl, "Target.createTarget", { url: href, newWindow: true });
  } else {
    await launchChrome([
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Une fenêtre recouverte continue d'être rendue : capture CDP possible sans la montrer.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--new-window",
      href,
    ]);
  }
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (!(await alive())) continue;
    const hit = (await tabs()).find((t) => t.url.startsWith(href.replace(/\/$/, "")) || t.url === href);
    if (hit) {
      let fresh = hit;
      for (let j = 0; j < 20 && (fresh.title === "" || fresh.title === fresh.url); j++) {
        await sleep(500);
        fresh = (await tabs()).find((t) => t.id === hit.id) ?? fresh;
      }
      return { title: fresh.title, url: fresh.url, profile: PROFILE, port: PORT };
    }
  }
  throw Error(`Chrome isolé : onglet ${href} introuvable sur le port ${PORT}.`);
}

async function cdp(wsUrl, method, params = {}, timeoutMs = 15000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(Error("CDP : connexion impossible"));
  });
  try {
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(Error(`CDP : ${method} sans réponse`)), timeoutMs);
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.id !== 1) return;
        clearTimeout(t);
        if (msg.error) rej(Error(`CDP : ${msg.error.message}`));
        else res(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

async function shot(file, match) {
  if (!file) throw Error("Usage : shot <fichier.png> [motif]");
  const all = await tabs();
  const pick = match ? all.filter((t) => t.url.includes(match) || t.title.includes(match)) : all;
  const tab = pick[0];
  if (!tab) throw Error(`Aucun onglet du Chrome isolé ne correspond à « ${match ?? ""} ».`);
  // Une fenêtre recouverte n'est pas rendue : on tente sans la déplacer, puis on ramène
  // au premier plan notre propre onglet (jamais une fenêtre de l'utilisateur).
  let data;
  try {
    ({ data } = await cdp(tab.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, 6000));
  } catch {
    await cdp(tab.webSocketDebuggerUrl, "Page.bringToFront");
    await sleep(800);
    ({ data } = await cdp(tab.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" }));
  }
  const out = path.resolve(file);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  return { file: out, title: tab.title, url: tab.url };
}

const [cmd, a, b] = process.argv.slice(2);
try {
  const result =
    cmd === "open" ? await open(a) : cmd === "list" ? (await tabs()).map(({ title, url }) => ({ title, url })) : cmd === "shot" ? await shot(a, b) : null;
  if (result === null) throw Error("Commandes : open <url> | list | shot <fichier.png> [motif]");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
