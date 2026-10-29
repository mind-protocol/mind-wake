/**
 * Daemon minimal exécuté dans un processus séparé : ouvre la base du banc, lance la
 * session autorisée par le parent et attend. Le parent le tue brutalement pour simuler
 * un crash du daemon pendant la session.
 *
 *   node --import ts-hooks.ts daemon-child.ts <dataDir> <scénario base64url> <grant base64url>
 */

import type { FakeScenario } from "../../../src/adapters/fake/index.js";
import type { LaunchGrant } from "../../../src/runner/index.js";
import { openBench } from "./setup.js";

const [dir, scenarioArg, grantArg] = process.argv.slice(2);
if (dir === undefined || scenarioArg === undefined || grantArg === undefined) {
  throw new Error("arguments manquants");
}
const decode = (value: string): unknown =>
  JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

const bench = openBench(dir);
const runner = bench.runner(decode(scenarioArg) as FakeScenario);
const running = await runner.launch(decode(grantArg) as LaunchGrant);
process.stdout.write(`launched ${running.sessionId}\n`);
const result = await running.done;
process.stdout.write(`done ${JSON.stringify(result)}\n`);
bench.close();
