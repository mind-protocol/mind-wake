import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const LIMITS = Object.freeze({
  file: 131072,
  body: 150000,
  response: 400000,
  entries: 200,
  deadline: 5000,
});
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const inside = (root, target) =>
  target === root ||
  (!path.relative(root, target).startsWith("..") && !path.isAbsolute(path.relative(root, target)));
const allowed = (name) =>
  name.length > 0 &&
  !name.startsWith(".") &&
  !/^(?:node_modules|vendor|credentials|secrets|profiles|AppData)$/i.test(name) &&
  !/(?:secret|credential|private.?key|password|token)/i.test(name) &&
  !/[<>:"\\|?*\x00-\x1f]/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);
const textExtension = (name) =>
  /\.(?:txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|html|svg|csv|yaml|yml|toml|rs|py|cs|gd|glsl|sh)$/i.test(
    name,
  );

// Reject links/junctions in ALL existing ancestors, including those above the selected root.
function noLinks(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail("unsafe_path");
  }
  if (fs.realpathSync.native(target).toLowerCase() !== target.toLowerCase()) fail("unsafe_path");
}

function locate(root, relative, directory = false) {
  if (typeof relative !== "string" || relative.length > 1024 || relative.includes("\\"))
    fail("unsafe_path");
  const parts = relative === "" && directory ? [] : relative.split("/");
  if (parts.some((part) => part === ".." || part === "." || !allowed(part))) fail("unsafe_path");
  const target = path.resolve(root, ...parts);
  if (!inside(root, target)) fail("unsafe_path");
  noLinks(target);
  const stat = fs.lstatSync(target);
  if (
    directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || !textExtension(target)
  )
    fail("unsupported_file");
  return target;
}

function readText(root, relative) {
  const target = locate(root, relative);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMITS.file) fail("file_limit");
    const buffer = Buffer.alloc(LIMITS.file + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > LIMITS.file) fail("file_limit");
    const bytes = buffer.subarray(0, count);
    const after = fs.fstatSync(fd);
    noLinks(target);
    const current = fs.statSync(target);
    if (
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("changed_during_read");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("unsupported_file");
    }
    if (text.includes("\0")) fail("unsupported_file");
    return {
      path: relative,
      bytes: count,
      modifiedAt: after.mtime.toISOString(),
      hash: hash(bytes),
      text,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function loadState(file) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state.version !== 1 || !Array.isArray(state.grants)) fail("invalid_state");
  return state;
}
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}
function mutateState(file, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Serialize cooperating operator processes; never silently break a stale lock.
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    const state = fs.existsSync(file) ? loadState(file) : { version: 1, grants: [] };
    const result = update(state);
    saveState(file, state);
    return result;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
export function grant(stateFile, root, participant, propose = false) {
  root = path.resolve(root);
  if (
    root
      .split(path.sep)
      .some((part) =>
        /^(?:\.git|\.ssh|\.aws|\.codex|\.claude|AppData|profiles|credentials|secrets)$/i.test(part),
      )
  )
    fail("invalid_selection");
  noLinks(root);
  if (
    !fs.statSync(root).isDirectory() ||
    root === path.parse(root).root ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(participant)
  )
    fail("invalid_selection");
  // Never share the profile root, state, or a parent containing either.
  if (
    inside(root, path.resolve(stateFile)) ||
    (process.env.USERPROFILE && inside(root, path.resolve(process.env.USERPROFILE)))
  )
    fail("invalid_selection");
  const token = randomBytes(32).toString("hex");
  const id = randomUUID();
  mutateState(stateFile, (state) => {
    state.grants.push({
      id,
      root,
      participant,
      tokenHash: hash(token),
      rights: propose ? ["read", "propose"] : ["read"],
      active: true,
    });
  });
  return { capability: id, participant, token };
}
export function revoke(stateFile, id) {
  mutateState(stateFile, (state) => {
    const entry = state.grants.find((g) => g.id === id);
    if (!entry) fail("unknown_capability");
    entry.active = false;
  });
}
function authorize(stateFile, req) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) fail("unauthorized");
  const cap = loadState(stateFile).grants.find(
    (g) => g.id === req.headers["x-workspace-capability"],
  );
  if (
    !cap?.active ||
    cap.participant !== req.headers["x-workspace-participant"] ||
    typeof cap.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(cap.tokenHash) ||
    !timingSafeEqual(Buffer.from(cap.tokenHash, "hex"), Buffer.from(hash(token), "hex"))
  )
    fail("unauthorized");
  return cap;
}
function operate(cap, body) {
  if (!body || typeof body !== "object" || !cap.rights.includes("read")) fail("forbidden");
  switch (body.op) {
    case "list": {
      const target = locate(cap.root, body.path ?? "", true);
      const dir = fs.opendirSync(target);
      const entries = [];
      let scanned = 0;
      let truncated = false;
      try {
        let entry;
        while ((entry = dir.readSync())) {
          if (++scanned > LIMITS.entries) {
            truncated = true;
            break;
          }
          if (!allowed(entry.name)) continue;
          const relative = [body.path, entry.name].filter(Boolean).join("/");
          try {
            if (entry.isDirectory()) {
              locate(cap.root, relative, true);
              entries.push({ name: entry.name, kind: "directory" });
            } else if (entry.isFile() && textExtension(entry.name)) {
              const { text, ...metadata } = readText(cap.root, relative);
              entries.push({ name: entry.name, kind: "file", ...metadata });
            }
          } catch {
            /* Unsafe, binary, changing or oversized entries are omitted. */
          }
        }
      } finally {
        dir.closeSync();
      }
      return { entries, truncated, scanned };
    }
    case "read":
      return readText(cap.root, body.path);
    case "propose": {
      if (!cap.rights.includes("propose")) fail("forbidden");
      const current = readText(cap.root, body.path);
      if (current.hash !== body.expectedHash) fail("hash_conflict");
      if (
        typeof body.text !== "string" ||
        Buffer.byteLength(body.text) > LIMITS.file ||
        body.text.includes("\0")
      )
        fail("file_limit");
      return {
        kind: "unapplied-replacement",
        path: body.path,
        expectedHash: current.hash,
        proposedHash: hash(body.text),
        text: body.text,
        applied: false,
      };
    }
    default:
      fail("forbidden");
  }
}

export function createWorkspaceServer({ stateFile, key, cert }) {
  let active = 0,
    windowAt = Date.now(),
    admissions = 0;
  const server = https.createServer(
    { key, cert, minVersion: "TLSv1.2", maxHeaderSize: 8192 },
    async (req, res) => {
      const send = (status, value) => {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      };
      if (Date.now() - windowAt >= 60000) {
        windowAt = Date.now();
        admissions = 0;
      }
      if (++admissions > 120 || active >= 4) return send(429, { error: "busy" });
      active++;
      const timer = setTimeout(() => req.destroy(), LIMITS.deadline);
      try {
        if (
          req.method !== "POST" ||
          req.url !== "/v1/workspace" ||
          req.headers["content-type"] !== "application/json"
        )
          fail("bad_request");
        authorize(stateFile, req);
        let length = 0;
        const chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > LIMITS.body) {
            send(413, { error: "body_limit" });
            req.resume();
            return;
          }
          chunks.push(chunk);
        }
        // Re-authorize AFTER receiving body: revocation during upload takes effect.
        const cap = authorize(stateFile, req);
        const result = operate(cap, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        send(200, { result });
      } catch (error) {
        const known = [
          "unauthorized",
          "forbidden",
          "unsafe_path",
          "unsupported_file",
          "file_limit",
          "hash_conflict",
          "changed_during_read",
          "bad_request",
        ];
        const code = known.includes(error.message) ? error.message : "operation_failed";
        send(code === "unauthorized" ? 401 : code === "hash_conflict" ? 409 : 400, { error: code });
      } finally {
        clearTimeout(timer);
        active--;
      }
    },
  );
  server.headersTimeout = LIMITS.deadline;
  server.requestTimeout = LIMITS.deadline;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  // No request, path, body, token or credential logging.
  return server;
}

export async function callWorkspace({ endpoint, ca, capability, participant, token }, body) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1/workspace"
  )
    fail("invalid_endpoint");
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > LIMITS.body) fail("body_limit");
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        ca,
        rejectUnauthorized: true,
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          "x-workspace-capability": capability,
          "x-workspace-participant": participant,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMITS.response) req.destroy(new Error("response_limit"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            result.error ? reject(new Error(result.error)) : resolve(result.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("deadline")), LIMITS.deadline);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(data);
  });
}
