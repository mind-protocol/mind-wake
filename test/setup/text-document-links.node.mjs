// Run after npm run desktop:ui, with an installed Chromium executable as argument.
// Uses the real reader/message controllers and HTML fixture, with a fake native boundary.
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const executable = process.argv[2];
assert(executable, 'Pass the path to an installed Chromium headless executable');
const temporary = await mkdtemp(join(tmpdir(), 'mind-text-links-'));
const moduleUrl = name => pathToFileURL(resolve('desktop/ui/build/' + name + '.js')).href;
const fixture = (await readFile('desktop/ui/index.html', 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
const payload = '<script>parent.attacked=true;</script>\n<h1>Literal</h1>\n<img src="x" onerror="parent.attacked=true">\n# Heading\n**bold** &lt;tag&gt;\n[link](next.txt)';
const page = fixture.replace('</body>', `<pre id="result">pending</pre><script>
window.addEventListener('error',event=>{document.getElementById('result').textContent='FAIL: '+event.message;});
window.addEventListener('unhandledrejection',event=>{document.getElementById('result').textContent='FAIL: '+event.reason;});
</script><script type="module">
import {initDocuments, parseDocument} from ${JSON.stringify(moduleUrl('documents'))};
import {initMessageFileLinks} from ${JSON.stringify(moduleUrl('message-file-links'))};
const assert = (value, label) => {if (!value) throw Error(label);};
const until = async (condition, label) => {
  for (let i=0;i<100;i++) {if (condition()) return; await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('Timed out: '+label);
};
try {
  localStorage.clear();
  const path='artifacts/projets/delegation-entre-ateliers/machinetomachine-draft.txt';
  const payload=${JSON.stringify(payload).replaceAll('<', '\\u003c')};
  const parsed=parseDocument(payload,'text');
  assert(parsed.body.children.length===1 && parsed.body.firstElementChild.tagName==='PRE','one plain pre');
  assert(parsed.body.firstElementChild.textContent===payload,'exact source text preserved');
  assert(!parsed.querySelector('script,img,h1,a,strong'),'no HTML or Markdown interpretation');
  const frame=document.getElementById('document-frame'), scope=document.getElementById('document-scope');
  const reads=[], opens=[], browses=[];
  let entries=[{name:'old.md',relative:'old.md'}];
  const invoke=async (command,args)=>{
    assert(command==='document_browse','only document boundary invoked');
    browses.push(args);
    if (!args.read) return {entries:args.scope==='agent'?entries:[],truncated:false};
    reads.push(args.relative);
    return {text:args.relative.endsWith('.txt')?payload:'# Existing Markdown',format:args.relative.endsWith('.txt')?'text':'markdown'};
  };
  initDocuments(invoke);
  window.addEventListener('wake-open-document',event=>opens.push(event.detail));
  const links=initMessageFileLinks(invoke);
  const message=(id,text)=>({id,text,at:new Date().toISOString()});
  links.observe([message('history',path)]);
  await until(()=>reads.includes('old.md') && frame.contentDocument?.querySelector('h1'),'initial Markdown');
  assert(opens.length===0,'historical txt not auto-opened');
  entries=[...entries,{name:'machinetomachine-draft.txt',relative:path},{name:'next.txt',relative:'next.txt'}];
  document.getElementById('view-documents').hidden=false;
  const chat=document.getElementById('chat');
  chat.textContent='Voir '+String.fromCharCode(96)+path+String.fromCharCode(96)+', puis next.txt.';
  const draft=document.createElement('textarea');draft.value='Brouillon à conserver';
  document.getElementById('view-documents').append(draft);draft.focus();
  const newMessage=message('new',chat.textContent);
  const before=browses.length;links.observe([newMessage]);
  await until(()=>chat.querySelectorAll('.message-file-link').length===2,'txt decoration after refresh');
  assert(browses.length>=before+2,'new txt triggered catalogue refresh in both scopes');
  assert(opens.length===0 && !document.getElementById('document-autoopen-status').hidden,'active draft defers auto-open');
  assert(draft.value==='Brouillon à conserver' && document.activeElement===draft,'draft and focus preserved');
  const button=chat.querySelector('.message-file-link');
  assert(button.tagName==='BUTTON' && button.type==='button' && button.textContent===path,'accessible filename button');
  assert(button.style.color==='rgb(153, 80, 13)' && button.style.fontWeight==='700','dark orange bold link retained');
  draft.value='';draft.dispatchEvent(new Event('input',{bubbles:true}));
  draft.blur();
  await until(()=>opens.length===1 && frame.contentDocument?.querySelector('pre')?.textContent===payload,'deferred plain text frame');
  const doc=frame.contentDocument;
  assert(!doc.querySelector('script,img,h1,a,strong') && !window.attacked,'literal tags survive serialization safely');
  const count=reads.length;
  links.observe([newMessage]);links.observe([message('older','next.txt')],true);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert(opens.length===1 && reads.length===count,'polling and history do not reopen');
  assert(document.getElementById('document-next').dataset.relative==='next.txt','Suivant retains second txt');
  document.getElementById('document-next').click();
  await until(()=>reads.at(-1)==='next.txt','Suivant opens next txt');
  const focus=document.createElement('input');document.body.append(focus);focus.focus();
  button.click();
  await until(()=>reads.at(-1)===path,'filename click opens txt');
  assert(document.activeElement===focus,'reader opening does not steal focus');
  scope.value='aurore';scope.dispatchEvent(new Event('change'));
  assert(document.getElementById('document-title').textContent==='Atelier d’Aurore','Aurore pending scope preserved');
  assert(!browses.some(args=>args.scope==='aurore'),'no Aurore fallback or native read');
  document.getElementById('result').textContent='PASS: literal txt DOM/frame, catalogue refresh, accessible orange button, draft/focus, Suivant, history/polling, Aurore';
} catch (error) {document.getElementById('result').textContent='FAIL: '+error.stack;}
</script></body>`);
try {
  const file=join(temporary,'test.html');await writeFile(file,page);
  const run=spawnSync(executable,['--headless','--no-sandbox','--disable-gpu','--allow-file-access-from-files',
    '--user-data-dir='+join(temporary,'profile'),'--dump-dom','--virtual-time-budget=10000',pathToFileURL(file).href],
    {encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024});
  const result=/<pre id="result">([^<]*)<\/pre>/.exec(run.stdout??'')?.[1];
  assert.equal(run.status,0,run.stderr||run.error?.message);
  assert(result?.startsWith('PASS:'),result??run.stdout);
  process.stdout.write(result+'\n');
} finally {await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
