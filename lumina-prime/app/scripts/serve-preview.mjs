import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const port=Number(process.env.PORT??3230);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let requested;
  try {requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  const file=path.resolve(root,'.'+requested);
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try {
    let target=file;try {if(!(await fs.stat(target)).isFile())target=path.join(root,'index.html');}catch{target=path.join(root,'index.html');}
    const data=await fs.readFile(target);
    res.writeHead(200,{'content-type':mime[path.extname(target)]??'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:data);
  }catch{res.writeHead(503,{'content-type':'text/plain; charset=utf-8'});res.end('Export web indisponible. Exécuter npm run build:web.');}
});
server.listen(port,'127.0.0.1',()=>console.log(`MIND compagnon : http://localhost:${port}`));
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Le port est déjà utilisé ; aucun second serveur lancé.':error.message);process.exitCode=1;});
