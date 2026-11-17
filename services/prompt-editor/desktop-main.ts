import { engineChoice, setEngineChoice } from "../../src/daemon/agent-engine.js";
import path from "node:path";
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const dataDir =
    process.env["MIND_WAKE_DATA_DIR"] ?? path.join(process.env["LOCALAPPDATA"] ?? "", "mind-wake");
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (request.action === "agentEngine") {
    const choice = request.preferred === undefined ? engineChoice(dataDir) : setEngineChoice(dataDir, request.preferred);
    console.log(JSON.stringify({preferred: choice?.preferred ?? null}));
  } else if (request.action === "callVision") {
    const { readCallVision } = await import("./vision.js");
    console.log(JSON.stringify(readCallVision(dataDir, request.call, request.after)));
  } else if (request.action === "vision") {
    const { readVision } = await import("./vision.js");
    console.log(JSON.stringify(readVision(dataDir, request)));
  } else {
    const { editPrompts } = await import("./editor.js");
    console.log(JSON.stringify(editPrompts(dataDir, request)));
  }
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
