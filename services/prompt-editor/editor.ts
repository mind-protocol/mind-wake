import { acquireInstanceLock } from "../../src/scheduler/instance-lock.js";
import { runtimeAgents } from "./runtime-agents.js";
import fs from "node:fs";
import path from "node:path";
import { readVision } from "./vision.js";
import { createHash, randomUUID } from "node:crypto";
import {
  loadPatternHolders,
  patternHoldersDir,
  holderRole,
  holderRoleFile,
  patternHolderSystemPrompt,
  routerSystemPrompt,
  parsePatternHolder,
} from "../../src/communication/pattern-holders.js";

export interface EditorRequest {
  action: "list" | "read" | "save" | "vision";
  agent?: string;
  part?: string;
  text?: string;
  revision?: string;
}
export interface EditorResponse {
  frames?: {id:number; time:string; target:string; cols:number; grid:string}[];
  agents?: { id: string; name: string }[];
  fields?: {
    id: string;
    label: string;
    text: string;
    revision: string;
    start: number;
    end: number;
  }[];
  invalid?: { file: string; error: string }[];
  parts?: { id: string; label: string }[];
  text?: string;
  editable?: boolean;
  revision?: string;
}
export function editPrompts(dataDir: string, request: EditorRequest): EditorResponse {
  if (request.action === "vision") return readVision(dataDir, request);
  if (request.action === "save") {
    const lock = acquireInstanceLock(path.join(dataDir, "prompt-editor.lock"));
    try {
      return handle(dataDir, request);
    } finally {
      lock.release();
    }
  }
  return handle(dataDir, request);
}
function preview(
  parts: { id: string; label: string }[],
  text: string,
  sources: { id: string; label: string; read: () => string }[],
) {
  const occupied: { start: number; end: number }[] = [];
  const fields = sources.map(({ id, label, read }) => {
    const raw = read();
    const fragment = raw.trim();
    let start = fragment ? text.indexOf(fragment) : -1;
    while (start >= 0 && occupied.some((r) => start < r.end && start + fragment.length > r.start))
      start = text.indexOf(fragment, start + 1);
    const end = start < 0 ? -1 : start + fragment.length;
    if (start >= 0) occupied.push({ start, end });
    return { id, label, text: raw, revision: hash(raw), start, end };
  });
  return { parts, text, fields, editable: true };
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function handle(dataDir: string, request: EditorRequest) {
  const root = patternHoldersDir(dataDir);
  const { holders, invalid } = loadPatternHolders(dataDir);
  if (request.action === "list")
    return {
      agents: [
        ...holders.map((h) => ({ id: h.slug, name: h.emoji + " " + h.name })),
        ...runtimeAgents(dataDir).map(({ id, name }) => ({ id, name })),
      ],
      invalid,
    };
  if (request.agent?.startsWith("wake:")) {
    const agent = runtimeAgents(dataDir).find((a) => a.id === request.agent);
    if (!agent) throw Error("Agent introuvable.");
    const parts = [
      {
        id: "preview",
        label: agent.last
          ? "Prompt de base"
          : agent.id.startsWith("wake:series:")
            ? "Instructions de reprise assemblées"
            : "Prompt complet",
      },
      ...(agent.last ? [{ id: "last", label: "Prompt complet du dernier appel" }] : []),
      ...agent.sources.map(({ id, label }) => ({ id, label })),
    ];
    const part = request.part ?? "preview";
    if (request.action === "read" && part === "preview")
      return preview(parts, agent.preview(), agent.sources);
    if (request.action === "read" && part === "last" && agent.last)
      return { parts, text: agent.last(), editable: false };
    const source = agent.sources.find((s) => s.id === part);
    if (!source) throw Error("Choisis la source à modifier.");
    return editSource(request, parts, source.file, source.read);
  }
  const h = holders.find((h) => h.slug === request.agent);
  if (!h) throw Error("Agent introuvable. Recharge la liste.");
  const router = h.slug === "reveilleur";
  const names = h.sections ?? [path.basename(h.file)];
  const parts = [
    { id: "preview", label: "Prompt complet" },
    { id: "role", label: router ? "Rôle du Réveilleur" : "Rôle partagé des Holders" },
    ...names.map((name) => ({ id: "file:" + name, label: name })),
  ];
  const part = request.part ?? "preview";
  if (!parts.some((p) => p.id === part)) throw Error("Source inconnue.");
  if (request.action === "read" && part === "preview")
    return preview(parts, router ? routerSystemPrompt(root, h) : patternHolderSystemPrompt(h), [
      { ...parts[1]!, read: () => holderRole(root, router) },
      ...names.map((name) => ({
        id: "file:" + name,
        label: name,
        read: () => fs.readFileSync(h.sections ? path.join(h.file, name) : h.file, "utf8"),
      })),
    ]);
  const role = part === "role";
  const name = part.slice(5);
  const file = role ? holderRoleFile(root, router) : h.sections ? path.join(h.file, name) : h.file;
  if (part === "preview") throw Error("Choisis la partie à modifier.");
  const read = () => (role ? holderRole(root, router) : fs.readFileSync(file, "utf8"));

  return editSource(request, parts, file, read, (text) => {
    if (!role) {
      const proposed = h.sections
        ? names
            .map((n) => (n === name ? text : fs.readFileSync(path.join(h.file, n), "utf8")))
            .join("\n\n---\n\n")
        : text;
      const parsed = parsePatternHolder(h.file, proposed);
      if ("error" in parsed) throw Error(parsed.error);
    }
  });
}

function editSource(
  request: EditorRequest,
  parts: { id: string; label: string }[],
  file: string,
  read: () => string,
  validate?: (text: string) => void,
) {
  if (request.action === "read") {
    const text = read();
    return { parts, text, editable: true, revision: hash(text) };
  }
  if (request.action !== "save" || typeof request.text !== "string" || !request.text.trim())
    throw Error("Texte vide ou demande invalide.");
  const text = request.text;
  validate?.(text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), "_" + randomUUID() + ".tmp");
  try {
    fs.writeFileSync(temp, text, { flag: "wx" });
    if (hash(read()) !== request.revision)
      throw Error(
        "Cette source a changé. Ton brouillon est conservé. Recharge pour lire la nouvelle version.",
      );
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { revision: hash(text) };
}
