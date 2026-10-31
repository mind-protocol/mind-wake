/** Publishable snapshot, excluding all live profiles, Git history and personal notes. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyPublisherSignature } from "./authenticode.mjs";
const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    archive: { type: "string" },
    "native-launcher": { type: "string" },
    "with-dependencies": { type: "boolean" },
  },
});
if (!values.stage || !values.archive)
  throw Error("--stage NEW_DIRECTORY --archive FILE.zip required");
const repo = fileURLToPath(new URL("../", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim())
  throw Error("Clean pinned Git source required");
const stamp = JSON.parse(fs.readFileSync(path.join(repo, "dist/runtime-build.json"), "utf8"));
if (stamp.revision !== revision || stamp.dirty !== false)
  throw Error("Clean runtime build from pinned revision required");
for (const [file, hash] of Object.entries(stamp.files)) {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
    throw Error("Invalid runtime stamp path");
  if (
    createHash("sha256")
      .update(fs.readFileSync(path.join(repo, file)))
      .digest("hex") !== hash
  )
    throw Error("Runtime build changed: " + file);
}
const stage = path.resolve(values.stage),
  archive = path.resolve(values.archive);
if (fs.existsSync(stage) || fs.existsSync(archive))
  throw Error("Stage and archive must not already exist");
const root = path.join(stage, "mind-wake");
const top = new Set([
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc.json",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "SPEC.md",
  "TRANSACTIONS.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "eslint.config.js",
  "tsconfig.build.json",
  "tsconfig.json",
  "vitest.config.ts",
  "install.md",
]);
const dirs = new Set([
  "src",
  "services",
  "scripts",
  "desktop",
  "test",
  "docs",
  "prompts",
  "skills",
  "examples",
]);
const files = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: repo, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const selected = files.filter(
  (file) => top.has(file) || file === "install-wake.ps1" || dirs.has(file.split("/")[0]),
);
fs.mkdirSync(root, { recursive: true });
let copied = 0;
for (const file of selected) {
  if (
    /(^|\/)(?:\.local|\.claude|\.codex|node_modules|target|gen|build)(\/|$)|\.(?:sqlite|db|log)(?:-|$)|(^|\/)\.env(?:\.|$)/i.test(
      file,
    )
  )
    throw Error("Forbidden release path: " + file);
  const source = path.join(repo, file);
  if (!fs.existsSync(source)) continue;
  if (!fs.lstatSync(source).isFile()) throw Error("Only regular files accepted: " + file);
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  copied++;
}
// These sections record workstation-specific consents, not permissions for a recipient.
const agents = path.join(root, "AGENTS.md");
fs.writeFileSync(
  agents,
  fs
    .readFileSync(agents, "utf8")
    .replace(/## Contexte visuel de réveil[\s\S]*?(?=## Capacités natives des runtimes)/, "")
    .replace(/## Texte saisi au réveil[\s\S]*$/, ""),
);
const binary = path.join(repo, "desktop/src-tauri/target/release/mind-wake-desktop.exe");
if (!fs.existsSync(binary)) throw Error("Build the release desktop first");
// Generated runtime and embedded UI must accompany the source and desktop.
for (const relative of ["dist", "desktop/ui/build"])
  fs.cpSync(path.join(repo, relative), path.join(root, relative), { recursive: true });
if (values["with-dependencies"]) {
  // Copy only packages selected by the existing lockfile, never a user's npm config.
  const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8"));
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.startsWith("node_modules/") || entry.dev) continue;
    if (entry.link || relative.split("/").includes("..")) throw Error("Linked dependency refused");
    fs.cpSync(path.join(repo, relative), path.join(root, relative), { recursive: true });
  }
}
fs.mkdirSync(path.join(root, "bin"), { recursive: true });
fs.copyFileSync(binary, path.join(root, "bin/mind-wake-desktop.exe"));
let nativeLauncher = null;
if (values["native-launcher"]) {
  const { bundledJobLauncher } = await import("../dist/runner/bundled-launcher.js");
  const directory = path.resolve(values["native-launcher"]);
  const status = bundledJobLauncher(directory);
  if (!status?.available) throw Error(status?.reason || "Native launcher missing");
  nativeLauncher = JSON.parse(fs.readFileSync(path.join(directory, "job-launcher.json"), "utf8"));
  if (nativeLauncher.signature?.status !== "Valid")
    throw Error("Seal the signed launcher before packaging");
  const signature = verifyPublisherSignature(status.launcherPath);
  if (signature.thumbprint !== nativeLauncher.signature.thumbprint)
    throw Error("Launcher signer differs from sealed manifest");
  const destination = path.join(root, "bin/native");
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(status.launcherPath, path.join(destination, nativeLauncher.file));
  fs.copyFileSync(
    path.join(directory, "job-launcher.json"),
    path.join(destination, "job-launcher.json"),
  );
}
fs.writeFileSync(
  path.join(root, "RELEASE.json"),
  JSON.stringify(
    {
      format: "mind-wake.windows-source-and-desktop.v1",
      platform: "win32-x64",
      createdAt: new Date().toISOString(),
      baseCommit: revision,
      dirty: false,
      source: "clean-pinned-git-build",
      runtimeBuild: "dist/runtime-build.json",
      dependencies: values["with-dependencies"]
        ? "existing-lockfile-production-packages"
        : "operator-npm-ci-required",
      desktop: "bin/mind-wake-desktop.exe",
      signed: false,
      nativeLauncher,
      includesPrivateProfile: false,
    },
    null,
    2,
  ),
);
fs.mkdirSync(path.dirname(archive), { recursive: true });
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:WAKE_PACKAGE_STAGE, $env:WAKE_PACKAGE_ARCHIVE)",
  ],
  {
    env: { ...process.env, WAKE_PACKAGE_STAGE: stage, WAKE_PACKAGE_ARCHIVE: archive },
    stdio: "pipe",
  },
);
const hash = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
console.log(
  JSON.stringify({
    archive,
    stage: root,
    sourceFiles: copied,
    bytes: fs.statSync(archive).size,
    sha256: hash,
  }),
);
