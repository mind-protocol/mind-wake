import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ProfileId, SessionId } from "../contracts/index.js";
import { ProcessTreeSupervisor } from "../runner/process-tree.js";

it.runIf(process.platform === "win32")(
  "permits children up to 16 active processes and refuses the next creation without killing their parent",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-limit-16-"));
    const supervisor = new ProcessTreeSupervisor(dir);
    const profile = "limit-16-fixture" as ProfileId;
    const session = "provider" as SessionId;
    const source = `const{spawn}=require('node:child_process');
    const children=[];
    (async()=>{
      for(let i=0;i<15;i++){
        const child=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore'],windowsHide:true,detached:true});
        await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j)});
        children.push(child);
      }
      console.log('at-limit');
      process.stdin.once('data',()=>{
        let reported=false;const report=()=>{if(!reported){reported=true;console.log('creation-refused');process.stdin.once('data',()=>process.exit(0));}};
        try {const extra=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore'],windowsHide:true,detached:true});
        extra.once('error',report);extra.once('exit',report);}catch(e){report();}
      });
    })().catch(e=>{console.log(String(e));process.exit(1)});`;
    const child = supervisor.spawn(profile, session, {
      executable: process.execPath,
      args: ["-e", source],
      maxProcesses: 16,
    });
    try {
      const mainPid = await child.started();
      expect(await child.readLine()).toBe("at-limit");
      const before = supervisor.query(profile, session).active;
      expect(before).toBe(16);
      const details = supervisor.query(profile, session, true);
      expect(details.processes).toHaveLength(16);
      expect(details.processes).toContainEqual({ pid: mainPid, name: "node" });
      child.send("attempt-extra");
      expect(await child.readLine()).toBe("creation-refused");
      expect(supervisor.query(profile, session).active).toBe(before);
      expect(child.hasExited).toBe(false);
      child.send("finish");
      expect((await child.exited).mainExitCode).toBe(0);
    } finally {
      await child.terminateTree(1000);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
