import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";

const root = fileURLToPath(new URL("./", import.meta.url));
const port = Number(process.env.TECH_TREE_PORT || 8791);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};
const server = createServer(async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const name = path === "/" ? "index.html" : path.slice(1);
    if (!["index.html", "tree.json"].includes(name)) throw new Error("not found");
    const file = resolve(root, name);
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Introuvable");
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => console.log(`Agent tech tree: http://127.0.0.1:${port}`));
