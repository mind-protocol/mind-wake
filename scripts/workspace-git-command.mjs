import { execFile } from "node:child_process";
const args = JSON.parse(process.argv[2]);
execFile("git", args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
  console.log(JSON.stringify({ failed: Boolean(error), stdout, stderr }));
});
