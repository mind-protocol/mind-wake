/** Exit a stdio MCP worker when its client launcher disappears. */
import { pathToFileURL } from "node:url";
const parent = process.ppid;
const watchdog = setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 1000);
watchdog.unref();
process.stdin.once("end", () => process.exit(0));
await import(pathToFileURL(process.argv[2]).href);
