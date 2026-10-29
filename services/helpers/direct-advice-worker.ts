import fs from "node:fs";
import path from "node:path";
import { jobOutputDir } from "../../src/daemon/background-jobs.js";
import {
  directProfile,
  directSessions,
  executeDirectAdvice,
  recordDirectState,
  type DirectRequest,
} from "./direct-advice.js";
import { createOfficialWaker } from "./wake.js";
const dir = path.resolve(process.argv[2]!),
  id = process.argv[3]!;
const output = process.env["MIND_WAKE_JOB_OUTPUT"],
  job = process.env["MIND_WAKE_JOB_ID"];
if (
  !/^direct_[a-f0-9]{32}$/.test(id) ||
  !output ||
  !job ||
  path.resolve(output) !== jobOutputDir(dir, job)
)
  throw new Error("Invalid supervised direct advice context");
try {
  const request = JSON.parse(
    fs.readFileSync(path.join(dir, "direct-advice", id + ".json"), "utf8"),
  ) as DirectRequest;
  if (request.id !== id) throw new Error("Direct request identity mismatch");
  // The supervisor deliberately strips the caller environment. Restore only job
  // identity and the helper configuration captured by the authorized submission.
  const env = {
    MIND_WAKE_DATA_DIR: dir,
    MIND_WAKE_BACKGROUND_JOBS: "1",
    ...(request.helpersDir ? { MIND_WAKE_HELPERS_DIR: request.helpersDir } : {}),
  };
  directProfile(env, true);
  const wake = createOfficialWaker({ maxAnswerChars: null, ...request.cli });
  const result = await executeDirectAdvice(dir, request, await directSessions(env), wake);
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify({ thread_id: id, ...result }, null, 2),
  );
  if (result.status !== "answered") process.exitCode = 1;
} catch (error) {
  recordDirectState(
    dir,
    id,
    "failed",
    "Consultation échouée : " + (error instanceof Error ? error.message : String(error)),
  );
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify({
      thread_id: id,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
