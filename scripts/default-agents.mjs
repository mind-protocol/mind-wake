/** Install the shipped prompt corpus once, preserving every existing local file. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function installDefaultAgents(repoDir, workspace) {
  const bundle = path.join(repoDir, "prompts/default-agents");
  const manifestFile = path.join(bundle, "manifest.json");
  // Compatibility with older portable distributions.
  if (!fs.existsSync(manifestFile)) return { installed: false, created: [] };
  fs.mkdirSync(workspace, { recursive: true });
  const root = fs.realpathSync(workspace);
  const marker = path.join(root, ".mind-wake-default-agents.json");
  if (fs.existsSync(marker)) return { installed: false, created: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const safe = (base, relative) => {
    if (typeof relative !== "string" || relative.split(/[\\/]/).some(p => p === "..") || path.isAbsolute(relative))
      throw Error("Invalid default agent path");
    return path.join(base, relative);
  };
  const files = manifest.files.map(entry => {
    const bytes = fs.readFileSync(safe(bundle, entry.file));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw Error("Default agent corpus changed: " + entry.file);
    return { ...entry, bytes, target: safe(root, entry.target) };
  });
  const existingPersonality = fs.existsSync(path.join(root, "artifacts/PERSONALITY.md"));
  const created = [], skipped = [];
  for (const entry of files) {
    if (entry.target === path.join(root, "artifacts/agent-identity.json") && existingPersonality) {
      skipped.push(entry.target);
      continue;
    }
    // Check each existing ancestor before creating anything beneath it.
    let current = root;
    for (const part of path.relative(root, path.dirname(entry.target)).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) fs.mkdirSync(current);
      if (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory())
        throw Error("Default agent destination is not a local directory: " + current);
    }
    try {
      fs.writeFileSync(entry.target, entry.bytes, { flag: "wx" });
      created.push(entry.target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      skipped.push(entry.target);
    }
  }
  fs.writeFileSync(marker, JSON.stringify({ version: manifest.version, created, skipped }, null, 2) + "\n", { flag: "wx" });
  return { installed: true, created, skipped };
}
