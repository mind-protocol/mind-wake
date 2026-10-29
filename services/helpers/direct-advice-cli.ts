import fs from "node:fs";
import path from "node:path";
import {
  directSessions,
  queueDirectAdvice,
  readDirectThread,
  sessionRef,
} from "./direct-advice.js";
try {
  const [command, ...args] = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i],
      value = args[i + 1];
    if (
      !name ||
      !["--data-dir", "--helpers-dir", "--input", "--thread"].includes(name) ||
      value === undefined ||
      options.has(name)
    )
      throw new Error(
        "Usage: repo-advice.mjs list|send|read --data-dir PATH [--helpers-dir PATH] [--input JSON_FILE|--thread ID]",
      );
    options.set(name, value);
  }
  const data = options.get("--data-dir");
  if (!data) throw new Error("Explicit --data-dir is required");
  const env = {
    ...process.env,
    MIND_WAKE_DATA_DIR: path.resolve(data),
    MIND_WAKE_BACKGROUND_JOBS: "1",
    ...(options.has("--helpers-dir")
      ? { MIND_WAKE_HELPERS_DIR: path.resolve(options.get("--helpers-dir")!) }
      : {}),
  };
  let result: unknown;
  if (command === "list")
    result = {
      sessions: (await directSessions(env))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((s) => ({
          target: sessionRef(s),
          repo: s.cwd,
          runtime: s.runtime,
          updated_at: s.updatedAt,
        })),
    };
  else if (command === "read" && options.has("--thread"))
    result = readDirectThread(env, options.get("--thread")!);
  else if (command === "send" && options.has("--input")) {
    const raw = JSON.parse(fs.readFileSync(options.get("--input")!, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof raw["target"] !== "string" ||
      typeof raw["topic"] !== "string" ||
      raw["topic"].length < 3 ||
      raw["topic"].length > 160 ||
      typeof raw["context"] !== "string" ||
      raw["context"].length > 6000 ||
      typeof raw["idempotency_key"] !== "string" ||
      raw["idempotency_key"].length < 8 ||
      raw["idempotency_key"].length > 128
    )
      throw new Error(
        "Input requires target, topic (3–160 chars), context (0–6000), idempotency_key (8–128)",
      );
    result = await queueDirectAdvice(env, {
      target: raw["target"],
      topic: raw["topic"],
      context: raw["context"],
      idempotencyKey: raw["idempotency_key"],
    });
  } else throw new Error("Unknown command or missing --input / --thread");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n",
  );
  process.exitCode = 1;
}
