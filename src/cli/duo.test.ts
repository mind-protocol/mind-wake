import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { processContext } from "./context.js";
import { runCli } from "./run.js";
it("persists Mode Duo through the exact Settings CLI route without starting or resuming Wake", async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duo-cli-'));
 try {
  const cli=async(action:string)=>{let text='';const code=await runCli(['coach',action,'--data-dir',dir,'--json'],{...processContext(),env:{},stdout:s=>{text+=s;},stderr:s=>{text+=s;}});return {code,result:JSON.parse(text) as {ok:boolean;data:{enabled:boolean}}};};
  expect((await cli('duo-status')).result.data.enabled).toBe(false);
  expect((await cli('duo-on')).code).toBe(0);
  expect((await cli('duo-status')).result.data.enabled).toBe(true);
  expect((await cli('duo-off')).result.data.enabled).toBe(false);
  expect(fs.readdirSync(dir)).toEqual(['duo.json']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
