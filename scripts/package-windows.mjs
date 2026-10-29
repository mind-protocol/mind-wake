/** Publishable snapshot, excluding all live profiles, Git history and personal notes. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {verifyPublisherSignature} from './authenticode.mjs';
const {values} = parseArgs({options:{stage:{type:'string'},archive:{type:'string'},'native-launcher':{type:'string'}}});
if (!values.stage || !values.archive) throw Error('--stage NEW_DIRECTORY --archive FILE.zip required');
const repo = fileURLToPath(new URL('../',import.meta.url));
const stage = path.resolve(values.stage), archive=path.resolve(values.archive);
if(fs.existsSync(stage)||fs.existsSync(archive)) throw Error('Stage and archive must not already exist');
const root=path.join(stage,'mind-wake');
const top=new Set(['.gitattributes','.gitignore','.prettierignore','.prettierrc.json','AGENTS.md','CLAUDE.md','README.md','SPEC.md','TRANSACTIONS.md','LICENSE','package.json','package-lock.json','eslint.config.js','tsconfig.build.json','tsconfig.json','vitest.config.ts','install.md']);
const dirs=new Set(['src','services','scripts','desktop','test','docs','prompts','skills']);
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:repo,encoding:'utf8'}).split('\0').filter(Boolean);
const selected=files.filter(file=>top.has(file)||file==='install-wake.ps1'||dirs.has(file.split('/')[0]));
fs.mkdirSync(root,{recursive:true});
let copied=0;
for(const file of selected){
  if(/(^|\/)(?:\.local|\.claude|\.codex|node_modules|target|gen|build)(\/|$)|\.(?:sqlite|db|log)(?:-|$)|(^|\/)\.env(?:\.|$)/i.test(file)) throw Error('Forbidden release path: '+file);
  const source=path.join(repo,file);
  if(!fs.existsSync(source))continue;
  if(!fs.lstatSync(source).isFile())throw Error('Only regular files accepted: '+file);
  const dest=path.join(root,file); fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest);copied++;
}
// These sections record workstation-specific consents, not permissions for a recipient.
const agents=path.join(root,'AGENTS.md');
fs.writeFileSync(agents,fs.readFileSync(agents,'utf8').replace(/## Contexte visuel de réveil[\s\S]*?(?=## Capacités natives des runtimes)/,'').replace(/## Texte saisi au réveil[\s\S]*$/,''));
const binary=path.join(repo,'desktop/src-tauri/target/release/mind-wake-desktop.exe');
if(!fs.existsSync(binary))throw Error('Build the release desktop first');
fs.mkdirSync(path.join(root,'bin'),{recursive:true});fs.copyFileSync(binary,path.join(root,'bin/mind-wake-desktop.exe'));
let nativeLauncher=null;
if(values['native-launcher']){
  const {bundledJobLauncher}=await import('../dist/runner/bundled-launcher.js');
  const directory=path.resolve(values['native-launcher']);
  const status=bundledJobLauncher(directory);
  if(!status?.available)throw Error(status?.reason||'Native launcher missing');
  nativeLauncher=JSON.parse(fs.readFileSync(path.join(directory,'job-launcher.json'),'utf8'));
  if(nativeLauncher.signature?.status!=='Valid')throw Error('Seal the signed launcher before packaging');
  const signature=verifyPublisherSignature(status.launcherPath);
  if(signature.thumbprint!==nativeLauncher.signature.thumbprint)throw Error('Launcher signer differs from sealed manifest');
  const destination=path.join(root,'bin/native');fs.mkdirSync(destination,{recursive:true});
  fs.copyFileSync(status.launcherPath,path.join(destination,nativeLauncher.file));
  fs.copyFileSync(path.join(directory,'job-launcher.json'),path.join(destination,'job-launcher.json'));
}
fs.writeFileSync(path.join(root,'RELEASE.json'),JSON.stringify({format:'mind-wake.windows-source-and-desktop.v1',platform:'win32-x64',createdAt:new Date().toISOString(),baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),source:'working-tree-snapshot',desktop:'bin/mind-wake-desktop.exe',signed:false,nativeLauncher,includesPrivateProfile:false},null,2));
fs.mkdirSync(path.dirname(archive),{recursive:true});
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:WAKE_PACKAGE_STAGE, $env:WAKE_PACKAGE_ARCHIVE)'],{env:{...process.env,WAKE_PACKAGE_STAGE:stage,WAKE_PACKAGE_ARCHIVE:archive},stdio:'pipe'});
const hash=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
console.log(JSON.stringify({archive,stage:root,sourceFiles:copied,bytes:fs.statSync(archive).size,sha256:hash}));
