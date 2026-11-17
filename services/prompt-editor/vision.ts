import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { EditorRequest, EditorResponse } from "./editor.js";

export function readCallVision(dataDir: string, call: string, after: number) {
  if (!/^[0-9a-f-]{36}$/i.test(call) || !Number.isSafeInteger(after) || after < 0)
    throw Error("Identifiant d’appel ou de capture invalide.");
  const file = path.join(dataDir, "desktop-vision.sqlite");
  if (!fs.existsSync(file)) return {events: []};
  const db = new Database(file, {readonly:true});
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='call_frames'").get()) return {events: []};
    const rows = db.prepare("SELECT id,at,author,target,payload FROM call_frames WHERE call=? AND id>? ORDER BY id LIMIT 3").all(call, after) as {
      id:number; at:number; author:string; target:string; payload:string
    }[];
    return {events:rows.map(({payload,...info}) => ({...info,...JSON.parse(payload)}))};
  } finally { db.close(); }
}

export function readVision(dataDir: string, request: EditorRequest): EditorResponse {
  const file = path.join(dataDir, "desktop-vision.sqlite");
  if (!fs.existsSync(file)) return {agents: [], frames: []};
  const db = new Database(file, {readonly: true});
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='frames'").get()) return {agents: [], frames: []};
    const agents = db.prepare("SELECT agent AS id, label AS name FROM frames GROUP BY agent, label ORDER BY label").all() as NonNullable<EditorResponse["agents"]>;
    const frames = db.prepare("SELECT id,time,target,cols,grid FROM frames WHERE agent=? ORDER BY id DESC LIMIT 12").all(request.agent ?? "") as NonNullable<EditorResponse["frames"]>;
    return {agents, frames};
  } finally { db.close(); }
}
