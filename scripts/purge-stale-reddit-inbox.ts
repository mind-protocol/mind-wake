import path from "node:path";
import { purgeStaleRedditMessages } from "../src/communication/owner-inbox.js";

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write("Usage: node ... scripts/purge-stale-reddit-inbox.ts <data-dir>\n");
  process.exitCode = 2;
} else {
  const count = purgeStaleRedditMessages(path.resolve(dataDir));
  process.stdout.write(`Reddit stale inbox messages marked delivered: ${String(count)}\n`);
}
