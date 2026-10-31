/** Fixed, opt-in local clone reader. No network, checkout, fetch or credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export const ORIGIN = 'https://github.com/mind-protocol/scisense-aurore-workspace.git';
const format = p => /\.md$|\.markdown$/i.test(p) ? 'markdown' : /\.html?$/i.test(p) ? 'html' : /\.txt$/i.test(p) ? 'text' : null;
const safe = p => typeof p === 'string' && p.length <= 4096 && p.split('/').every(x => x && x !== '.' && x !== '..' && !/[\\:\x00-\x1f<>"|?*]/.test(x) && !/[. ]$/.test(x) && !x.startsWith('.'));
function confined(base, relative, allowMissing = false) {
  let cursor = base;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('alias');
    } catch(error) {
      // Committed blobs remain readable after an uncommitted deletion. No disk fallback.
      if(allowMissing && error.code==='ENOENT')return path.resolve(base,relative);
      throw error;
    }
  }
  const real = fs.realpathSync(cursor), rel = path.relative(base, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('escape');
  return real;
}
export function browseGitDocuments(dataDir, request) {
  if (!dataDir) return {state:'not-configured'};
  try {
    const base = fs.realpathSync(dataDir);
    let configPath = path.join(base, 'atelier-aurore.json');
    if (!fs.existsSync(configPath)) return {state:'not-configured'};
    configPath = confined(base, 'atelier-aurore.json');
    if (fs.statSync(configPath).size > 4096) throw Error('config');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.enabled !== true) return {state:'not-configured'};
    if (Object.keys(config).some(k => !['enabled','origin'].includes(k)) || config.origin !== ORIGIN) return {state:'invalid-origin'};
    const clone = confined(base, 'linked-workspaces/aurore-mind-protocol');
    // An embedded Git directory is required: no worktree pointer or external gitdir.
    const dotgit = confined(clone, '.git');
    if (!fs.statSync(dotgit).isDirectory()) throw Error('gitdir');
    const env = {...process.env, GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'};
    for (const k of Object.keys(env)) if (k.startsWith('GIT_') && !['GIT_OPTIONAL_LOCKS','GIT_TERMINAL_PROMPT','GIT_NO_REPLACE_OBJECTS','GIT_NO_LAZY_FETCH'].includes(k)) delete env[k];
    const git = (...args) => execFileSync('git', ['--no-pager','-c','core.fsmonitor=false','-c','log.showSignature=false','-C',clone,...args], {env,windowsHide:true,timeout:5000,maxBuffer:12000000,stdio:['ignore','pipe','pipe']});
    let origins;
    try {origins = git('config','--null','--local','--get-all','remote.origin.url').toString().split('\0').slice(0,-1);}
    catch (error) {return {state:error.status === 1 ? 'invalid-origin' : 'error'};}
    if (origins.length !== 1 || origins[0] !== ORIGIN) return {state:'invalid-origin'};
    let version;
    try {version = git('rev-parse','--verify','HEAD^{commit}').toString().trim();}
    catch {
      // Only an unborn branch counts as empty. Corrupt refs/objects are errors.
      const ref = git('symbolic-ref','-q','HEAD').toString().trim();
      try {git('show-ref','--quiet','--verify',ref); return {state:'error'};} catch (e) {if (e.status !== 1) return {state:'error'};}
      return {state:'empty',entries:[],version:null};
    }
    if (request.version != null && request.version !== version) return {state:'version-changed',version};
    // The daemon holds this during validation/fetch/FF. Do not catalogue a moving checkout.
    if(fs.existsSync(path.join(dotgit,'mind-wake-workspace-sync.lock')))return {state:'syncing',version};
    const provenance = {origin:ORIGIN,version};
    let sync;
    try {
      const file=confined(base,'aurore-sync-state.json');
      if(fs.statSync(file).size<=4096) {
        const value=JSON.parse(fs.readFileSync(file,'utf8'));
        // Only display fixed state fields; never forward arbitrary state-file content.
        sync={status:String(value.status??'unknown'),lastSuccessAt:value.lastSuccessAt??null,error:value.error??null};
      }
    } catch { /* No daemon synchronisation status yet. */ }
    const metadata={...provenance,...(sync?{sync}:{})};
    // Versioned catalogue request is a cheap local probe for the already-open desktop.
    if(request.read===false && request.relative==='' && request.version===version)return {state:'unchanged',...metadata};
    const records = git('ls-tree','-r','-z','--long',version).toString('utf8').split('\0').filter(Boolean);
    const files = new Map();
    for (const record of records) {
      const match = /^(100644|100755) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(record);
      if (!match || !safe(match[4])) continue;
      try {const disk=confined(clone,match[4],true);if(fs.existsSync(disk)&&!fs.statSync(disk).isFile())continue;} catch {continue;}
      files.set(match[4], {oid:match[2],size:Number(match[3])});
    }
    if (!request || typeof request.read !== 'boolean' || (request.relative !== '' && !safe(request.relative))) throw Error('request');
    if (!request.read) {
      if (request.relative !== '') throw Error('catalog-root');
      const documents = [...files.keys()].filter(p => format(p)).sort();
      const dates=new Map();
      let dateUnavailableReason='history-limit-or-unavailable';
      try {
        const shallow = new Set(git('rev-parse','--is-shallow-repository').toString().trim()==='true'
          ? fs.readFileSync(confined(dotgit,'shallow'),'utf8').trim().split(/\s+/) : []);
        // One bounded history walk for the catalogue, never one process per file.
        // Renames count as a modification of the new path (no invented pre-rename date).
        const history=git('log','--topo-order','--max-count=20000','--format=%x00%H%x09%ct','--name-only','-z','--no-renames','--no-ext-diff','--no-textconv',version,'--').toString('utf8');
        let stamp=null, boundary=false;
        for(const token of history.split('\0')) {
          const header=/^([a-f0-9]{40,64})\t([0-9]+)$/.exec(token.trim());
          if(header){stamp=Number(header[2])*1000;boundary=shallow.has(header[1]);continue;}
          const relative=token.replace(/^\n/,'');
          if(stamp!==null&&files.has(relative)&&!dates.has(relative)) dates.set(relative,boundary
            ? {modifiedAt:null,dateUnavailableReason:'shallow-history-boundary'}
            : {modifiedAt:stamp,modifiedAtSource:'git-path-commit'});
        }
        if(shallow.size) dateUnavailableReason='shallow-history-unavailable';
      } catch { /* Bound reached or incomplete history: keep content usable with honest dates. */ }
      const entries = documents.map(relative => ({relative,name:path.posix.basename(relative),directory:false,
        ...(dates.get(relative)??{modifiedAt:null,dateUnavailableReason})}));
      entries.sort((a,b)=>(b.modifiedAt??0)-(a.modifiedAt??0)||a.relative.localeCompare(b.relative));
      if(fs.existsSync(path.join(dotgit,'mind-wake-workspace-sync.lock'))||git('rev-parse','HEAD').toString().trim()!==version)return {state:'version-changed'};
      return {state:entries.length?'available':'empty',...metadata,entries:entries.slice(0,10000),truncated:documents.length>10000};
    }
    const file = files.get(request.relative), kind = format(request.relative);
    if (!file || (request.image ? !/\.(png|jpe?g|gif|webp)$/i.test(request.relative) : !kind) || file.size > (request.image?8000000:2000000)) throw Error('file');
    const bytes = git('cat-file','blob',file.oid);
    if(fs.existsSync(path.join(dotgit,'mind-wake-workspace-sync.lock'))||git('rev-parse','HEAD').toString().trim()!==version)return {state:'version-changed'};
    return request.image ? {state:'available',version,bytes:[...bytes]} : {state:'available',...metadata,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),format:kind};
  } catch {return {state:'error'};}
}
