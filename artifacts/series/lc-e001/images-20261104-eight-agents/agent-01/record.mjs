import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const [agent,id,src,inspection]=process.argv.slice(2);
const dir=path.resolve(`artifacts/series/lc-e001/images-20261104-eight-agents/agent-${agent}`);
const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8').replace(/^\uFEFF/,''));
const c=m.cuts.find(x=>x.cut_id===id); const dest=path.join(dir,id+'.png');
fs.copyFileSync(src,dest);
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let r={agent:Number(agent),cuts:[]};try{r=JSON.parse(fs.readFileSync(path.join(dir,'RESULTS.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
r.cuts=r.cuts.filter(x=>x.cut_id!==id);
r.cuts.push({cut_id:id,status:'produced',image_path:dest,sha256:hash(dest),prompt:c.prompt_image,references:c.reference_images,inspection});
fs.writeFileSync(path.join(dir,'RESULTS.json'),JSON.stringify(r,null,2));
fs.writeFileSync(path.join(dir,'PROGRESS.json'),JSON.stringify({agent:Number(agent),total:m.cuts.length,produced:r.cuts.length,status:r.cuts.length===m.cuts.length?'complete':'generating'},null,2));
