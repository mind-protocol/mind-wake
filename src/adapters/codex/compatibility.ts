/** Local schema export, no account, model request or version allowlist. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { CodexExecutable } from "./command.js";
import { asRecord } from "./protocol.js";

export interface CodexCompatibility {
  readonly steering: boolean;
}

const METHODS = [
  "initialize",
  "account/read",
  "account/rateLimits/read",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
];
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  ThreadStartParams: ["cwd", "approvalPolicy", "sandbox", "modelProvider"],
  ThreadResumeParams: ["threadId", "cwd", "approvalPolicy", "sandbox"],
  TurnStartParams: ["threadId", "input"],
  TurnInterruptParams: ["threadId", "turnId"],
  ThreadTokenUsageUpdatedNotification: ["threadId", "tokenUsage"],
  TokenUsageBreakdown: [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ],
  TurnCompletedNotification: ["threadId", "turn"],
};

/** Inspect the CLI's own exported schemas. Wire responses remain independently checked. */
export function inspectCodexSchemas(documents: readonly unknown[]): CodexCompatibility {
  const methods = new Set<string>();
  const types = new Map<string, Readonly<Record<string, unknown>>>();
  const walk = (value: unknown, name?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const title = record["title"];
    if (typeof title === "string") types.set(title, record);
    if (name && ["properties", "type", "enum", "oneOf", "anyOf"].some((key) => key in record))
      types.set(name, record);
    const method = asRecord(asRecord(record["properties"])?.["method"]);
    if (method) {
      if (typeof method["const"] === "string") methods.add(method["const"]);
      if (Array.isArray(method["enum"]))
        for (const item of method["enum"]) if (typeof item === "string") methods.add(item);
    }
    for (const [key, item] of Object.entries(record)) walk(item, key);
  };
  for (const document of documents) walk(document);
  const referenced = (reference: string): unknown =>
    types.get((reference.split("/").at(-1) ?? "").replace(/\.json$/, ""));
  const accepts = (value: unknown, kind: string, depth = 0): boolean => {
    const schema = asRecord(value);
    if (!schema || depth > 20) return false;
    const reference = schema["$ref"];
    if (typeof reference === "string") return accepts(referenced(reference), kind, depth + 1);
    if (schema["type"] === kind || (Array.isArray(schema["type"]) && schema["type"].includes(kind)))
      return true;
    if (typeof schema["const"] === kind) return true;
    if (Array.isArray(schema["enum"]) && schema["enum"].some((item) => typeof item === kind))
      return true;
    return ["anyOf", "oneOf", "allOf"].some(
      (key) =>
        Array.isArray(schema[key]) &&
        schema[key].some((item: unknown) => accepts(item, kind, depth + 1)),
    );
  };
  const hasValue = (value: unknown, expected: string, depth = 0): boolean => {
    const schema = asRecord(value);
    if (!schema || depth > 20) return false;
    if (typeof schema["$ref"] === "string")
      return hasValue(referenced(schema["$ref"]), expected, depth + 1);
    if (
      schema["const"] === expected ||
      (Array.isArray(schema["enum"]) && schema["enum"].includes(expected))
    )
      return true;
    return ["anyOf", "oneOf"].some(
      (key) =>
        Array.isArray(schema[key]) &&
        schema[key].some((item: unknown) => hasValue(item, expected, depth + 1)),
    );
  };
  for (const method of METHODS)
    if (!methods.has(method))
      throw new Error(
        `protocole Codex incompatible : méthode ${method} absente ; mettre Codex à jour puis réessayer`,
      );
  for (const [name, fields] of Object.entries(FIELDS)) {
    const properties = asRecord(types.get(name)?.["properties"]);
    for (const field of fields) {
      const kind =
        name === "TokenUsageBreakdown"
          ? "integer"
          : field === "input"
            ? "array"
            : ["tokenUsage", "turn"].includes(field)
              ? "object"
              : "string";
      if (!properties || !(field in properties) || !accepts(properties[field], kind))
        throw new Error(
          `protocole Codex incompatible : ${name}.${field} absent ou type modifié ; mettre Codex à jour puis réessayer`,
        );
    }
  }
  for (const name of ["ThreadStartParams", "ThreadResumeParams"]) {
    const schema = types.get(name);
    const properties = asRecord(schema?.["properties"]);
    for (const mode of ["read-only", "workspace-write", "danger-full-access"])
      if (!hasValue(properties?.["sandbox"], mode))
        throw new Error(`protocole Codex incompatible : ${name}.sandbox ne propose plus ${mode}`);
    if (!hasValue(properties?.["approvalPolicy"], "never"))
      throw new Error(
        `protocole Codex incompatible : ${name}.approvalPolicy ne propose plus never`,
      );
  }
  const supplied: Readonly<Record<string, readonly string[]>> = {
    ThreadStartParams: ["cwd", "approvalPolicy", "sandbox", "developerInstructions"],
    ThreadResumeParams: ["threadId", "cwd", "approvalPolicy", "sandbox", "excludeTurns"],
    TurnStartParams: ["threadId", "input"],
    TurnInterruptParams: ["threadId", "turnId"],
  };
  for (const [name, fields] of Object.entries(supplied)) {
    const required = types.get(name)?.["required"];
    if (
      Array.isArray(required) &&
      required.some((field) => typeof field !== "string" || !fields.includes(field))
    )
      throw new Error(`protocole Codex incompatible : ${name} exige un nouveau paramètre`);
  }
  const steerParams = asRecord(types.get("TurnSteerParams")?.["properties"]);
  const steerResponse = asRecord(types.get("TurnSteerResponse")?.["properties"]);
  return {
    steering:
      methods.has("turn/steer") &&
      accepts(steerParams?.["threadId"], "string") &&
      accepts(steerParams?.["expectedTurnId"], "string") &&
      accepts(steerParams?.["input"], "array") &&
      accepts(steerResponse?.["turnId"], "string"),
  };
}

export async function checkCodexCompatibility(
  executable: CodexExecutable,
): Promise<CodexCompatibility> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wake-codex-schema-"));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        executable.path,
        [...(executable.prefixArgs ?? []), "app-server", "generate-json-schema", "--out", dir],
        {
          timeout: 15_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                /^(SystemRoot|SystemDrive|windir|PATH|TEMP|TMP)$/i.test(key),
              ),
            ),
            CODEX_HOME: path.join(dir, "home"),
          },
        },
        (error) => {
          if (error)
            reject(
              new Error(
                "Export du protocole Codex impossible (commande, délai ou droits). Mettre Codex à jour puis réessayer.",
              ),
            );
          else resolve();
        },
      );
    });
    const documents: unknown[] = [];
    const read = async (folder: string): Promise<void> => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await read(file);
        else if (entry.isFile() && entry.name.endsWith(".json"))
          documents.push(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
      }
    };
    await read(dir);
    return inspectCodexSchemas(documents);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
