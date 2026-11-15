import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const run=read(path.join(root,'RUN.json'));
const seen=new Set(), rows=[], errors=[], prompts=[];
for(const lot of run.agents){
  const manifest=read(lot.manifest);
  for(const cut of manifest.cuts){
    prompts.push(cut);
    if(seen.has(cut.cut_id)) errors.push('duplicate:'+cut.cut_id);
    seen.add(cut.cut_id);
    const filename=path.join(manifest.output_dir,cut.cut_id+'.png');
    if(!fs.existsSync(filename)){rows.push({cut_id:cut.cut_id,status:'missing'});continue;}
    const b=fs.readFileSync(filename);
    const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const width=png?b.readUInt32BE(16):0,height=png?b.readUInt32BE(20):0;
    if(!png||width<1000||height<500)errors.push('invalid-image:'+cut.cut_id);
    rows.push({cut_id:cut.cut_id,status:'present',width,height,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});
  }
}
const result={checked_at:new Date().toISOString(),expected:116,unique_cut_ids:seen.size,present:rows.filter(r=>r.status==='present').length,missing:rows.filter(r=>r.status==='missing').map(r=>r.cut_id),errors,assets:rows};
if(seen.size!==116)result.errors.push('expected-116-cuts');
fs.writeFileSync(path.join(root,'integrity.json'),JSON.stringify(result,null,2));
fs.writeFileSync(path.join(root,'prompts-lc-e001.json'),JSON.stringify({episode_id:'lc-e001',cuts:prompts.sort((a,b)=>a.order-b.order)},null,2));
console.log(JSON.stringify({expected:116,present:result.present,missing:result.missing.length,errors}));
