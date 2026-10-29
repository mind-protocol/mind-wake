/**
 * Faux exécutable `claude` pour les tests de l'adapter : rejoue des flux `stream-json`
 * conformes aux types documentés (`SDKMessage`), sans aucun appel modèle ni réseau.
 *
 * - `--version` : imprime une version.
 * - Sinon lit un message utilisateur `stream-json` sur stdin, joue le scénario
 *   `FAKE_CLAUDE_SCENARIO`, puis attend comme le vrai CLI en entrée `stream-json`
 *   (l'entrée reste ouverte) : c'est à l'adapter de terminer le processus.
 * - `FAKE_CLAUDE_STATE` : dossier où les sessions créées par `--session-id` sont notées,
 *   avec leurs totaux cumulés, pour simuler `--resume`.
 * - `FAKE_CLAUDE_LOG` : chaque invocation y ajoute ses arguments et noms de variables.
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function emit(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function hold(): void {
  // Comme le vrai CLI en entrée stream-json : attend d'autres messages.
  setInterval(() => undefined, 60_000);
}

if (argv.includes("--version")) {
  process.stdout.write(`${process.env["FAKE_CLAUDE_VERSION"] ?? "2.1.308"} (Claude Code)\n`);
  process.exit(0);
}

const log = process.env["FAKE_CLAUDE_LOG"];
if (log !== undefined) {
  fs.appendFileSync(
    log,
    `${JSON.stringify({ argv, env: Object.keys(process.env).sort(), cwd: process.cwd() })}\n`,
  );
}

const scenario = process.env["FAKE_CLAUDE_SCENARIO"] ?? "success";
const state = process.env["FAKE_CLAUDE_STATE"] ?? process.cwd();
const newId = option("--session-id");
const resumeId = option("--resume");
const sessionId = newId ?? resumeId ?? "00000000-0000-4000-8000-000000000000";
const sessionFile = path.join(state, `${sessionId}.json`);

interface Totals {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

function result(fields: Record<string, unknown>): void {
  emit({
    type: "result",
    subtype: "success",
    uuid: "r",
    session_id: sessionId,
    duration_ms: 10,
    duration_api_ms: 5,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    ...fields,
  });
}

function startupError(text: string): never {
  result({
    subtype: "error_during_execution",
    is_error: true,
    errors: [text],
    num_turns: 0,
  });
  process.exit(1);
}

if (newId !== undefined && fs.existsSync(sessionFile)) {
  startupError(`Session ID ${newId} is already in use.`);
}
if (resumeId !== undefined && !fs.existsSync(sessionFile)) {
  startupError(`No conversation found with session ID: ${resumeId}`);
}

const previous: Totals = fs.existsSync(sessionFile)
  ? (JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Totals)
  : { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };

function init(): void {
  if (newId !== undefined && !argv.includes("--no-session-persistence")) {
    fs.writeFileSync(sessionFile, JSON.stringify(previous));
  }
  emit({
    type: "system",
    subtype: "init",
    uuid: "i",
    session_id: sessionId,
    apiKeySource: "none",
    claude_code_version: "2.1.308",
    cwd: process.cwd(),
    tools: (option("--tools") ?? "").split(",").filter((t) => t !== ""),
    mcp_servers: [],
    model: option("--model") ?? "opus",
    permissionMode: argv.includes("--dangerously-skip-permissions")
      ? "bypassPermissions"
      : (option("--permission-mode") ?? "default"),
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
  });
}

/** Usage du seul appel, reprise comprise, comme mesuré avec Claude Code 2.1.308. */
function successResult(run: Totals): void {
  const totals: Totals = {
    input: previous.input + run.input,
    cacheCreation: previous.cacheCreation + run.cacheCreation,
    cacheRead: previous.cacheRead + run.cacheRead,
    output: previous.output + run.output,
  };
  if (fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, JSON.stringify(totals));
  result({
    num_turns: 2,
    terminal_reason: "completed",
    usage: { input_tokens: run.input, output_tokens: run.output },
    modelUsage: {
      "claude-opus": {
        inputTokens: run.input,
        outputTokens: run.output,
        cacheReadInputTokens: run.cacheRead,
        cacheCreationInputTokens: run.cacheCreation,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
  });
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}): void {
  emit({
    type: "assistant",
    uuid: "a",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "assistant", content },
    ...extra,
  });
}

function play(userContent: string): void {
  if(scenario==="foreground-preemption") {
    init();
    emit({type:"system",subtype:"task_started",task_id:"worker",tool_use_id:"tool-worker",is_backgrounded:false});
    input.on("line",line=>{
      const control=JSON.parse(line) as {type?:string;uuid?:string;request_id?:string;request?:{subtype?:string}};
      if(control.type==="user" && control.uuid)emit({...control,isReplay:true,session_id:sessionId,parent_tool_use_id:null});
      if(control.type!=="control_request" || control.request?.subtype!=="background_tasks")return;
      emit({type:"control_response",response:{subtype:"success",request_id:control.request_id,response:{backgrounded:true}}});
      successResult({input:10,cacheCreation:0,cacheRead:20,output:30});
      setTimeout(()=>{
        fs.writeFileSync(path.join(process.cwd(),"background-finished.txt"),"worker survived the parent result");
        emit({type:"system",subtype:"task_notification",task_id:"worker",status:"completed"});
        successResult({input:20,cacheCreation:0,cacheRead:40,output:60});
      },600);
    });
    return;
  }
  const usageMode = process.env["FAKE_CLAUDE_USAGE"] ?? "fixed";
  if (userContent === "/usage" && usageMode !== "fixed") {
    // `fresh` : jauge basse, remises à zéro relatives à maintenant ; `none` : pas de jauge.
    const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
    assistant([{ type: "text", text: "usage" }], {
      usage_report: {
        session: {},
        rate_limits:
          usageMode === "none"
            ? null
            : {
                limits: [
                  { kind: "session", group: "session", percent: 20, resets_at: inHours(2) },
                  { kind: "weekly_all", group: "weekly", percent: 30, resets_at: inHours(72) },
                ],
              },
      },
    });
    result({});
    hold();
    return;
  }
  if (userContent === "/usage") {
    assistant([{ type: "text", text: "usage" }], {
      usage_report: {
        session: {},
        rate_limits: {
          limits: [
            {
              kind: "session",
              group: "session",
              percent: 23.5,
              resets_at: "2026-10-29T18:00:00Z",
              severity: "normal",
              is_active: true,
            },
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 61,
              resets_at: "2026-11-02T09:00:00Z",
              scope: { model: { display_name: "Opus" } },
              severity: "warning",
              is_active: false,
            },
            {
              kind: "monthly_mystery",
              group: "other",
              percent: 5,
              resets_at: null,
              severity: "normal",
              is_active: false,
            },
          ],
        },
      },
    });
    result({});
    return;
  }
  switch (scenario) {
    case "success":
      init();
      process.stdout.write("pas du json\n");
      assistant([
        { type: "text", text: "Je regarde l'espace." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ]);
      emit({ type: "user", session_id: sessionId, message: { role: "user", content: [] } });
      emit({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 529,
        error: "overloaded",
        uuid: "x",
        session_id: sessionId,
      });
      assistant([{ type: "text", text: "Terminé." }]);
      successResult({ input: 100, cacheCreation: 20, cacheRead: 30, output: 50 });
      break;
    case "rate_limited":
      init();
      emit({
        type: "rate_limit_event",
        uuid: "rl",
        session_id: sessionId,
        rate_limit_info: {
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 3_600,
          utilization: 1,
        },
      });
      assistant([{ type: "text", text: "limit" }], { error: "rate_limit" });
      result({ is_error: true, api_error_status: 429 });
      break;
    case "auth_failed":
      init();
      assistant([{ type: "text", text: "Not logged in · Please run /login" }], {
        error: "authentication_failed",
      });
      result({ is_error: true, result: "Not logged in · Please run /login" });
      break;
    case "cut":
      init();
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }]);
      setTimeout(() => process.exit(3), 20);
      return;
    case "hang":
      init();
      break;
    default:
      startupError(`scénario inconnu : ${scenario}`);
  }
  hold();
}

const input = createInterface({ input: process.stdin });
// Comme le CLI en entrée stream-json : entrée fermée après le tour, sortie propre.
input.on("close", () => {
  if (scenario !== "hang") process.exit(0);
});
// `/compact`, comme le CLI 2.1.308 : statut, frontière de compaction, résultat sans usage,
// puis le message suivant est traité dans la même conversation. `FAKE_CLAUDE_COMPACT=noop` :
// résultat sans frontière (compaction sans effet, observée sans `--strict-mcp-config`).
function onLine(line: string): void {
  const message = JSON.parse(line) as { message?: { content?: unknown } };
  const content = message.message?.content;
  if (content === "/compact") {
    if (process.env["FAKE_CLAUDE_COMPACT"] !== "noop") {
      emit({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
      emit({
        type: "system",
        subtype: "compact_boundary",
        session_id: sessionId,
        compact_metadata: { trigger: "manual", pre_tokens: 242652, post_tokens: 3960 },
      });
    }
    result({});
    input.once("line", onLine);
    return;
  }
  play(typeof content === "string" ? content : "");
}
input.once("line", onLine);
