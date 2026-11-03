// Faux Claude Code pour le second fil : rejoue un flux stream-json minimal, sans modèle.
import readline from "node:readline";
const args = process.argv.slice(2);
const session = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const text = JSON.parse(line).message.content;
  // Le lanceur n'hérite pas de l'environnement : le scénario vient du message.
  const mode = /#(hang|limited)/.exec(String(text))?.[1] ?? "ok";
  out({
    type: "system",
    subtype: "init",
    session_id: session,
    model: "fake",
    tools: [],
    permissionMode: "bypassPermissions",
    claude_code_version: "2.1.308",
  });
  if (mode === "hang") return setInterval(() => undefined, 1000);
  if (mode === "limited")
    out({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 4102444800 },
    });
  out({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: `${args.includes("--resume") ? "resume" : "new"}:${String(text).split("\n")[0]}`,
        },
      ],
    },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: session,
    num_turns: 1,
    modelUsage: { fake: { inputTokens: 3, outputTokens: 2 } },
  });
});
