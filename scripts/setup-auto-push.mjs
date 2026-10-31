#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { git, gitContext, samePath } from "./auto-push.mjs";

const marker = "# mind-wake-auto-push:v1:";
const quote = (value) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\"'\"'") + "'";
function hook(binding) {
  return (
    "#!/bin/sh\n" +
    marker +
    Buffer.from(JSON.stringify(binding)).toString("base64url") +
    "\nexec " +
    [binding.node, binding.helper, "--repo", binding.repo, "--git-dir", binding.gitDir]
      .map(quote)
      .join(" ") +
    "\n"
  );
}
function owned(text) {
  const encoded = text.split("\n")[1];
  if (!encoded?.startsWith(marker)) return null;
  try {
    const binding = JSON.parse(
      Buffer.from(encoded.slice(marker.length), "base64url").toString("utf8"),
    );
    if (
      Object.keys(binding).sort().join(",") !== "gitDir,helper,node,repo" ||
      Object.values(binding).some((value) => typeof value !== "string" || !path.isAbsolute(value))
    )
      return null;
    return text === hook(binding) ? binding : null;
  } catch {
    return null;
  }
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768)
    throw Error("Hook is not an ordinary owned file; unchanged");
}
/** No git config writes. One exact checkout binding; other linked worktrees skip it. */
export function setupAutoPush({ repo, disable = false, env = process.env }) {
  const context = gitContext(repo, env),
    hooks = path.join(context.commonDir, "hooks"),
    file = path.join(hooks, "post-commit");
  if (
    path.relative(context.commonDir, file).startsWith("..") ||
    path.isAbsolute(path.relative(context.commonDir, file))
  )
    throw Error("Hook path escapes Git common directory");
  if (fs.existsSync(hooks)) {
    const stat = fs.lstatSync(hooks);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Hooks directory is not an ordinary directory; unchanged");
  }
  if (!disable && git(context.root, ["config", "--get", "core.hooksPath"], env).status === 0)
    throw Error(
      "core.hooksPath is already configured; unchanged. Integrate manually instead of replacing it.",
    );
  let previous = null;
  if (fs.existsSync(file)) {
    regular(file);
    previous = owned(fs.readFileSync(file, "utf8"));
    if (!previous) throw Error("Existing post-commit hook is not ours; unchanged");
    if (!samePath(previous.repo, context.root) || !samePath(previous.gitDir, context.gitDir))
      throw Error("Shared hook belongs to another linked checkout; unchanged");
  }
  if (disable) {
    if (previous) {
      regular(file);
      if (!owned(fs.readFileSync(file, "utf8")))
        throw Error("Hook changed during disable; unchanged");
      fs.unlinkSync(file);
    }
    return { state: "disabled", repo: context.root, hook: file };
  }
  const binding = {
    repo: context.root,
    gitDir: context.gitDir,
    node: fs.realpathSync(process.execPath),
    helper: fs.realpathSync(fileURLToPath(new URL("./auto-push.mjs", import.meta.url))),
  };
  const text = hook(binding);
  if (previous) {
    if (fs.readFileSync(file, "utf8") !== text)
      throw Error("Owned hook uses a different helper; disable it explicitly before reinstalling");
    return { state: "already-enabled", repo: context.root, hook: file };
  }
  if (!fs.existsSync(hooks)) fs.mkdirSync(hooks);
  fs.writeFileSync(file, text, { flag: "wx", mode: 0o755 });
  return { state: "enabled", repo: context.root, hook: file };
}
if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const { values } = parseArgs({
      options: { repo: { type: "string" }, disable: { type: "boolean", default: false } },
    });
    if (!values.repo) throw Error("--repo required");
    const result = setupAutoPush({ repo: values.repo, disable: values.disable });
    process.stdout.write(`[auto-push] ${result.state} for ${result.repo}\n`);
  } catch (error) {
    process.stderr.write(`[auto-push] ${error.message}\n`);
    process.exitCode = 1;
  }
}
